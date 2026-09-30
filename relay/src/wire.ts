import { PROTOCOL_VERSION } from "@pi-reach/protocol/outer";
import type { EndpointMetadata, RouteFrame } from "@pi-reach/protocol/outer";

import { JsonNumberToken, parseStrictJson, stringifyWire } from "./lossless-json.js";

export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_RESOLVE_WINDOW_MS = 300_000;
export const PAIRING_RESOLVE_LIMIT = 12;
const U64_MAX = 18_446_744_073_709_551_615n;
const I64_MIN = -9_223_372_036_854_775_808n;
const I64_MAX = 9_223_372_036_854_775_807n;
const CROCKFORD_BASE32 = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{8}$/;
const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const METADATA_KEYS = ["kind", "name", "cwd", "pid", "started_at", "model", "thinking", "working"] as const;

export type ExactInteger = number | bigint;
export type RelayEndpointMetadata = Omit<EndpointMetadata, "pid" | "started_at"> & {
  pid?: ExactInteger;
  started_at?: ExactInteger;
};
export type WireLimits = { maxAuthorizedOwners: number; maxSubscriptions: number; maxMetadataBytes: number };
export type HostHello = {
  role: "host";
  deviceId: string;
  endpointId: string;
  runtimeInstanceId: string;
  metadata: RelayEndpointMetadata;
  authorizedOwnerIds: Set<string>;
};
export type OwnerHello = { role: "owner"; ownerId: string };
export type ParsedHello = HostHello | OwnerHello;
export type EndpointUpdate = { metadata?: RelayEndpointMetadata; authorizedOwnerIds?: Set<string> };
export type PairingOffer = { code: string; endpointId: string; runtimeInstanceId: string; expiresAt: ExactInteger };
export type ResolvePairingCode = { requestId: string; code: string };

export class WireError extends Error {
  constructor(readonly kind: "invalid" | "limit", message: string) {
    super(message);
  }
}

function invalid(message: string): never {
  throw new WireError("invalid", message);
}

function limit(message: string): never {
  throw new WireError("limit", message);
}

export function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseStrictJson(text);
  } catch {
    return invalid("invalid json");
  }
  if (!isRecord(value)) return invalid("expected object");
  return value;
}

export function frameType(value: Record<string, unknown>): string {
  if (typeof value.type !== "string") return invalid("missing frame type");
  return value.type;
}

export function canonicalPublicKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return invalid("non-canonical public key");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) return invalid("invalid public key");
  return value;
}

export function parseHello(value: Record<string, unknown>, limits: WireLimits): ParsedHello {
  exactKeys(value, ["type", "protocol_version", "role", "pubkey", "endpoint_id", "runtime_instance_id", "metadata", "authorized_owner_ids"]);
  if (value.type !== "hello" || exactUnsigned(value.protocol_version, "protocol_version") !== PROTOCOL_VERSION) {
    return invalid("invalid hello version");
  }
  const identity = canonicalPublicKey(value.pubkey);
  if (value.role === "owner") {
    for (const key of ["endpoint_id", "runtime_instance_id", "metadata", "authorized_owner_ids"] as const) {
      if (value[key] !== undefined && value[key] !== null) return invalid("invalid owner hello");
    }
    return { role: "owner", ownerId: identity };
  }
  if (value.role !== "host") return invalid("invalid hello role");
  const endpointId = uuid(value.endpoint_id);
  const runtimeInstanceId = uuid(value.runtime_instance_id);
  const metadata = parseMetadata(value.metadata, limits.maxMetadataBytes);
  const rawOwners = value.authorized_owner_ids;
  if (rawOwners !== undefined && rawOwners !== null && !Array.isArray(rawOwners)) return invalid("invalid owner list");
  const owners = rawOwners ?? [];
  if (!Array.isArray(owners)) return invalid("invalid owner list");
  if (owners.length > limits.maxAuthorizedOwners) return limit("too many authorized owners");
  return {
    role: "host",
    deviceId: identity,
    endpointId,
    runtimeInstanceId,
    metadata,
    authorizedOwnerIds: new Set(owners.map(canonicalPublicKey)),
  };
}

export function parseRoute(value: Record<string, unknown>): RouteFrame {
  exactKeys(value, ["type", "purpose", "device_id", "endpoint_id", "runtime_instance_id", "target_owner_id", "source_owner_id", "ct"]);
  if (value.type !== "route" || (value.purpose !== "pairing" && value.purpose !== "session") || typeof value.ct !== "string") {
    return invalid("invalid route");
  }
  const target = optionalIdentity(value.target_owner_id);
  const source = optionalIdentity(value.source_owner_id);
  return {
    type: "route",
    purpose: value.purpose,
    device_id: canonicalPublicKey(value.device_id),
    endpoint_id: uuid(value.endpoint_id),
    runtime_instance_id: uuid(value.runtime_instance_id),
    ...(target === undefined ? {} : { target_owner_id: target }),
    ...(source === undefined ? {} : { source_owner_id: source }),
    ct: value.ct,
  };
}

export function parseSubscription(value: Record<string, unknown>, limits: WireLimits): string[] {
  exactKeys(value, ["type", "device_ids"]);
  if (value.type !== "subscribe_endpoints" || !Array.isArray(value.device_ids)) return invalid("invalid subscription");
  if (value.device_ids.length > limits.maxSubscriptions) return limit("too many subscriptions");
  return value.device_ids.map(canonicalPublicKey);
}

export function parseEndpointUpdate(value: Record<string, unknown>, limits: WireLimits): EndpointUpdate {
  exactKeys(value, ["type", "metadata", "authorized_owner_ids"]);
  if (value.type !== "endpoint_update") return invalid("invalid endpoint update");
  const update: EndpointUpdate = {};
  if (value.metadata !== undefined && value.metadata !== null) update.metadata = parseMetadata(value.metadata, limits.maxMetadataBytes);
  if (value.authorized_owner_ids !== undefined && value.authorized_owner_ids !== null) {
    if (!Array.isArray(value.authorized_owner_ids)) return invalid("invalid owner list");
    if (value.authorized_owner_ids.length > limits.maxAuthorizedOwners) return limit("too many authorized owners");
    update.authorizedOwnerIds = new Set(value.authorized_owner_ids.map(canonicalPublicKey));
  }
  if (update.metadata === undefined && update.authorizedOwnerIds === undefined) return invalid("empty endpoint update");
  return update;
}

export function parsePairingOffer(value: Record<string, unknown>): PairingOffer {
  exactKeys(value, ["type", "code", "endpoint_id", "runtime_instance_id", "expires_at"]);
  if (value.type !== "pairing_offer") return invalid("invalid pairing offer");
  return {
    code: normalizePairingCode(value.code),
    endpointId: uuid(value.endpoint_id),
    runtimeInstanceId: uuid(value.runtime_instance_id),
    expiresAt: exactUnsigned(value.expires_at, "expires_at"),
  };
}

export function parseResolvePairingCode(value: Record<string, unknown>): ResolvePairingCode {
  exactKeys(value, ["type", "request_id", "code"]);
  if (value.type !== "resolve_pairing_code" || typeof value.request_id !== "string" || value.request_id.length === 0) {
    return invalid("invalid pairing request");
  }
  return { requestId: value.request_id, code: normalizePairingCode(value.code) };
}

export function normalizePairingCode(value: unknown): string {
  // 必须先限制 ASCII，Unicode 大写映射可能把一个字符扩展为多个有效码字符。
  if (typeof value !== "string" || !CROCKFORD_BASE32.test(value)) return invalid("invalid pairing code");
  return value.toUpperCase();
}

export function compareExactInteger(value: ExactInteger, other: number): number {
  const left = typeof value === "bigint" ? value : BigInt(value);
  const right = BigInt(other);
  return left < right ? -1 : left > right ? 1 : 0;
}

export { stringifyWire };

function parseMetadata(value: unknown, maxBytes: number): RelayEndpointMetadata {
  if (!isRecord(value)) return invalid("invalid metadata");
  if (Buffer.byteLength(stringifyWire(value), "utf8") > maxBytes) return limit("metadata too large");
  exactKeys(value, METADATA_KEYS);
  if (value.kind !== "daemon" && value.kind !== "interactive") return invalid("invalid endpoint kind");
  const metadata: RelayEndpointMetadata = { kind: value.kind };
  copyOptional(value, metadata, "name", "string");
  copyOptional(value, metadata, "cwd", "string");
  copyOptionalInteger(value, metadata, "pid", true);
  copyOptionalInteger(value, metadata, "started_at", false);
  copyOptional(value, metadata, "model", "string");
  copyOptional(value, metadata, "thinking", "string");
  copyOptional(value, metadata, "working", "boolean");
  return metadata;
}

function copyOptional(source: Record<string, unknown>, target: Record<string, unknown>, key: string, type: "string" | "boolean"): void {
  const value = source[key];
  if (value === undefined || value === null) return;
  if (typeof value !== type) return invalid(`invalid metadata ${key}`);
  target[key] = value;
}

function copyOptionalInteger(source: Record<string, unknown>, target: RelayEndpointMetadata, key: "pid" | "started_at", unsigned: boolean): void {
  const value = source[key];
  if (value === undefined || value === null) return;
  target[key] = unsigned ? exactUnsigned(value, key) : exactSigned(value, key);
}

function exactUnsigned(value: unknown, name: string): ExactInteger {
  return exactInteger(value, 0n, U64_MAX, name);
}

function exactSigned(value: unknown, name: string): ExactInteger {
  return exactInteger(value, I64_MIN, I64_MAX, name);
}

function exactInteger(value: unknown, minimum: bigint, maximum: bigint, name: string): ExactInteger {
  let integer: bigint;
  if (value instanceof JsonNumberToken) {
    if (!/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value.source)) return invalid(`invalid integer ${name}`);
    integer = BigInt(value.source);
  } else if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) {
    integer = BigInt(value);
  } else {
    return invalid(`invalid integer ${name}`);
  }
  if (integer < minimum || integer > maximum) return invalid(`integer out of range ${name}`);
  return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
}

function optionalIdentity(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : canonicalPublicKey(value);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) return invalid("invalid uuid");
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) return invalid("unknown field");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof JsonNumberToken);
}
