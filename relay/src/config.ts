import { discoveryBaselineBytes } from "./discovery-budget.js";

export type RelayLimits = {
  maxFrameBytes: number;
  maxBufferedBytes: number;
  maxTotalBufferedBytes: number;
  maxDiscoveryBytes: number;
  maxConnections: number;
  maxPendingAuth: number;
  maxSubscriptions: number;
  maxAuthorizedOwners: number;
  maxMetadataBytes: number;
  helloTimeoutMs: number;
  authTimeoutMs: number;
  heartbeatIntervalMs: number;
  shutdownTimeoutMs: number;
};

export const DEFAULT_RELAY_LIMITS: Readonly<RelayLimits> = Object.freeze({
  maxFrameBytes: 4 * 1024 * 1024,
  maxBufferedBytes: 8 * 1024 * 1024,
  maxTotalBufferedBytes: 64 * 1024 * 1024,
  maxDiscoveryBytes: 4 * 1024 * 1024,
  maxConnections: 256,
  maxPendingAuth: 32,
  maxSubscriptions: 1024,
  maxAuthorizedOwners: 1024,
  maxMetadataBytes: 64 * 1024,
  helloTimeoutMs: 5_000,
  authTimeoutMs: 5_000,
  heartbeatIntervalMs: 25_000,
  shutdownTimeoutMs: 5_000,
});

const MAX_TIMER_MS = 2_147_483_647;
const TIMER_LIMITS = new Set<keyof RelayLimits>(["helloTimeoutMs", "authTimeoutMs", "heartbeatIntervalMs", "shutdownTimeoutMs"]);

const LIMIT_ENV: Readonly<Record<keyof RelayLimits, string>> = {
  maxFrameBytes: "PI_REACH_RELAY_MAX_FRAME_BYTES",
  maxBufferedBytes: "PI_REACH_RELAY_MAX_BUFFERED_BYTES",
  maxTotalBufferedBytes: "PI_REACH_RELAY_MAX_TOTAL_BUFFERED_BYTES",
  maxDiscoveryBytes: "PI_REACH_RELAY_MAX_DISCOVERY_BYTES",
  maxConnections: "PI_REACH_RELAY_MAX_CONNECTIONS",
  maxPendingAuth: "PI_REACH_RELAY_MAX_PENDING_AUTH",
  maxSubscriptions: "PI_REACH_RELAY_MAX_SUBSCRIPTIONS",
  maxAuthorizedOwners: "PI_REACH_RELAY_MAX_AUTHORIZED_OWNERS",
  maxMetadataBytes: "PI_REACH_RELAY_MAX_METADATA_BYTES",
  helloTimeoutMs: "PI_REACH_RELAY_HELLO_TIMEOUT_MS",
  authTimeoutMs: "PI_REACH_RELAY_AUTH_TIMEOUT_MS",
  heartbeatIntervalMs: "PI_REACH_RELAY_HEARTBEAT_INTERVAL_MS",
  shutdownTimeoutMs: "PI_REACH_RELAY_SHUTDOWN_TIMEOUT_MS",
};

function positiveInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function envInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  return positiveInteger(Number(raw), name);
}

export function resolveRelayLimits(overrides: Partial<RelayLimits> = {}): RelayLimits {
  const discoveryExplicit = overrides.maxDiscoveryBytes !== undefined;
  const limits = { ...DEFAULT_RELAY_LIMITS, ...overrides };
  if (!discoveryExplicit) limits.maxDiscoveryBytes = Math.min(limits.maxDiscoveryBytes, limits.maxBufferedBytes);
  for (const key of Object.keys(DEFAULT_RELAY_LIMITS) as Array<keyof RelayLimits>) {
    limits[key] = positiveInteger(limits[key], key, TIMER_LIMITS.has(key) ? MAX_TIMER_MS : Number.MAX_SAFE_INTEGER);
  }
  if (limits.maxPendingAuth > limits.maxConnections) {
    throw new Error("maxPendingAuth must not exceed maxConnections");
  }
  if (limits.maxBufferedBytes > limits.maxTotalBufferedBytes) {
    throw new Error("maxBufferedBytes must not exceed maxTotalBufferedBytes");
  }
  if (limits.maxDiscoveryBytes > limits.maxBufferedBytes) {
    throw new Error("maxDiscoveryBytes must not exceed maxBufferedBytes");
  }
  if (discoveryBaselineBytes(limits.maxSubscriptions) >= BigInt(limits.maxDiscoveryBytes)) {
    throw new Error("discovery baseline must be less than maxDiscoveryBytes");
  }
  return limits;
}

export type CliConfig = { host: string; port: number; limits: RelayLimits };

export function loadCliConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const rawPort = env.PI_REACH_RELAY_PORT;
  let port = 3000;
  if (rawPort !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(rawPort)) throw new Error("PI_REACH_RELAY_PORT must be an integer from 0 to 65535");
    port = Number(rawPort);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
      throw new Error("PI_REACH_RELAY_PORT must be an integer from 0 to 65535");
    }
  }

  const overrides: Partial<RelayLimits> = {};
  for (const key of Object.keys(LIMIT_ENV) as Array<keyof RelayLimits>) {
    const name = LIMIT_ENV[key];
    if (env[name] !== undefined) overrides[key] = envInteger(env, name, DEFAULT_RELAY_LIMITS[key]);
  }
  return { host: "0.0.0.0", port, limits: resolveRelayLimits(overrides) };
}
