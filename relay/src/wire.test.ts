import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyAuth } from "./auth.js";
import { DEFAULT_RELAY_LIMITS, resolveRelayLimits } from "./config.js";
import { parseEndpointUpdate, parseHello, parseJsonObject, parsePairingOffer, parseResolvePairingCode, parseRoute, stringifyWire, WireError } from "./wire.js";

const ENDPOINT_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME_ID = "22222222-2222-4222-8222-222222222222";
const limits = DEFAULT_RELAY_LIMITS;

function identity(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64");
}

describe("outer wire parser", () => {
  it("accepts only ASCII Crockford characters before case normalization", () => {
    for (const code of ["abcdefß", "ABCDEFSſ", "ABCDK234", "ＡBCD2345"]) {
      expect(() => parseResolvePairingCode({ type: "resolve_pairing_code", request_id: "test", code })).toThrow(WireError);
      expect(() => parsePairingOffer({ type: "pairing_offer", code, endpoint_id: ENDPOINT_ID, runtime_instance_id: RUNTIME_ID, expires_at: 1 })).toThrow(WireError);
    }
    expect(parseResolvePairingCode({ type: "resolve_pairing_code", request_id: "test", code: "abcd2345" }).code).toBe("ABCD2345");
  });

  it("normalizes nullable Rust Option fields while preserving UUID spelling", () => {
    const hello = parseHello(parseJsonObject(JSON.stringify({
      type: "hello",
      protocol_version: 2,
      role: "host",
      pubkey: identity(1),
      endpoint_id: ENDPOINT_ID.toUpperCase(),
      runtime_instance_id: RUNTIME_ID,
      metadata: { kind: "daemon", name: null, pid: 42, working: null },
      authorized_owner_ids: null,
    })), limits);
    expect(hello).toEqual({
      role: "host",
      deviceId: identity(1),
      endpointId: ENDPOINT_ID.toUpperCase(),
      runtimeInstanceId: RUNTIME_ID,
      metadata: { kind: "daemon", pid: 42 },
      authorizedOwnerIds: new Set(),
    });

    const route = parseRoute(parseJsonObject(JSON.stringify({
      type: "route",
      purpose: "session",
      device_id: identity(1),
      endpoint_id: ENDPOINT_ID,
      runtime_instance_id: RUNTIME_ID,
      target_owner_id: null,
      source_owner_id: null,
      ct: "not decoded",
    })));
    expect(route).not.toHaveProperty("target_owner_id");
    expect(route).not.toHaveProperty("source_owner_id");
    expect(route.ct).toBe("not decoded");
  });

  it("rejects noncanonical keys, duplicates, empty updates, and declared array overflow", () => {
    const base = { type: "hello", protocol_version: 2, role: "owner", pubkey: identity(1) };
    expect(() => parseHello({ ...base, pubkey: identity(1).replace(/=$/, "") }, limits)).toThrow(WireError);
    expect(() => parseJsonObject(`{"type":"hello","type":"hello"}`)).toThrow(WireError);
    expect(() => parseEndpointUpdate({ type: "endpoint_update", metadata: null }, limits)).toThrow(/empty/);
    expect(() => parseHello({
      type: "hello", protocol_version: 2, role: "host", pubkey: identity(1),
      endpoint_id: ENDPOINT_ID, runtime_instance_id: RUNTIME_ID, metadata: { kind: "daemon" },
      authorized_owner_ids: [identity(2), identity(3)],
    }, { ...limits, maxAuthorizedOwners: 1 })).toThrow(expect.objectContaining({ kind: "limit" }));
  });
});

describe("Ed25519 auth", () => {
  it("accepts a valid signature but rejects wrong nonces and extra auth fields", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" });
    const publicId = der.subarray(-32).toString("base64");
    const nonce = Buffer.alloc(32, 7);
    const signature = sign(null, nonce, privateKey).toString("base64");
    expect(verifyAuth(publicId, nonce, JSON.stringify({ type: "auth", sig: signature }))).toBe(true);
    expect(verifyAuth(publicId, Buffer.alloc(32, 8), JSON.stringify({ type: "auth", sig: signature }))).toBe(false);
    expect(verifyAuth(publicId, nonce, JSON.stringify({ type: "auth", sig: signature, extra: true }))).toBe(false);
    expect(verifyAuth(publicId, nonce, `{"type":"auth","sig":"${signature}","sig":"${signature}"}`)).toBe(false);
  });
});

describe("lossless integer handling", () => {
  it("round-trips unsafe metadata integers and accepts exact Rust boundaries", () => {
    const update = parseEndpointUpdate(parseJsonObject(
      `{"type":"endpoint_update","metadata":{"kind":"daemon","pid":18446744073709551615,"started_at":-9223372036854775808}}`,
    ), limits);
    expect(update.metadata?.pid).toBe(18_446_744_073_709_551_615n);
    expect(update.metadata?.started_at).toBe(-9_223_372_036_854_775_808n);
    expect(stringifyWire(update.metadata)).toBe(
      `{"kind":"daemon","pid":18446744073709551615,"started_at":-9223372036854775808}`,
    );

    const justUnsafe = parseEndpointUpdate(parseJsonObject(
      `{"type":"endpoint_update","metadata":{"kind":"daemon","pid":9007199254740993}}`,
    ), limits);
    expect(justUnsafe.metadata?.pid).toBe(9_007_199_254_740_993n);
    expect(stringifyWire(justUnsafe.metadata)).toContain(`"pid":9007199254740993`);

    const maxSigned = parseEndpointUpdate(parseJsonObject(
      `{"type":"endpoint_update","metadata":{"kind":"interactive","started_at":9223372036854775807}}`,
    ), limits);
    expect(maxSigned.metadata?.started_at).toBe(9_223_372_036_854_775_807n);
    const offer = parsePairingOffer(parseJsonObject(
      `{"type":"pairing_offer","code":"abc12345","endpoint_id":"${ENDPOINT_ID}","runtime_instance_id":"${RUNTIME_ID}","expires_at":18446744073709551615}`,
    ));
    expect(offer.expiresAt).toBe(18_446_744_073_709_551_615n);
  });

  it.each([
    `{"type":"endpoint_update","metadata":{"kind":"daemon","pid":18446744073709551616}}`,
    `{"type":"endpoint_update","metadata":{"kind":"daemon","started_at":9223372036854775808}}`,
    `{"type":"endpoint_update","metadata":{"kind":"daemon","started_at":-9223372036854775809}}`,
    `{"type":"endpoint_update","metadata":{"kind":"daemon","pid":2.0}}`,
    `{"type":"endpoint_update","metadata":{"kind":"daemon","pid":2e0}}`,
    `{"type":"endpoint_update","metadata":{"kind":"daemon","pid":-0}}`,
  ])("rejects a non-Rust integer token: %s", (text) => {
    expect(() => parseEndpointUpdate(parseJsonObject(text), limits)).toThrow(WireError);
  });

  it("rejects isolated surrogates and JSON beyond the Rust nesting bound", () => {
    expect(() => parseJsonObject(`{"value":"\\ud800"}`)).toThrow(WireError);
    const tooDeep = `{"value":${"[".repeat(128)}null${"]".repeat(128)}}`;
    expect(() => parseJsonObject(tooDeep)).toThrow(WireError);
  });

  it("rejects timer values that would overflow Node timers", () => {
    expect(() => resolveRelayLimits({ helloTimeoutMs: 2_147_483_648 })).toThrow(/2147483647/);
  });
});
