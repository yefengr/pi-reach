import { describe, expect, it } from "vitest";

import { DEFAULT_RELAY_LIMITS, loadCliConfig, resolveRelayLimits } from "./config.js";

describe("relay discovery configuration", () => {
  it("defaults to four MiB and clamps an implicit discovery budget to transport capacity", () => {
    expect(DEFAULT_RELAY_LIMITS.maxDiscoveryBytes).toBe(4 * 1024 * 1024);
    expect(resolveRelayLimits({ maxBufferedBytes: 128 * 1024 }).maxDiscoveryBytes).toBe(128 * 1024);
    expect(loadCliConfig({ PI_REACH_RELAY_MAX_BUFFERED_BYTES: "131072" }).limits.maxDiscoveryBytes).toBe(128 * 1024);
  });

  it("rejects an explicit discovery budget above transport capacity", () => {
    expect(() => resolveRelayLimits({ maxBufferedBytes: 1024, maxDiscoveryBytes: 1025 })).toThrow(/maxDiscoveryBytes/);
    expect(() => loadCliConfig({
      PI_REACH_RELAY_MAX_BUFFERED_BYTES: "1024",
      PI_REACH_RELAY_MAX_DISCOVERY_BYTES: "1025",
    })).toThrow(/maxDiscoveryBytes/);
  });

  it("rejects a baseline that consumes the configured discovery budget", () => {
    expect(() => resolveRelayLimits({ maxSubscriptions: 2, maxDiscoveryBytes: 188 })).toThrow(/baseline/);
  });

  it("loads an explicit positive integer discovery budget", () => {
    expect(loadCliConfig({ PI_REACH_RELAY_MAX_DISCOVERY_BYTES: "262144" }).limits.maxDiscoveryBytes).toBe(262_144);
    expect(() => loadCliConfig({ PI_REACH_RELAY_MAX_DISCOVERY_BYTES: "1.5" })).toThrow(/positive integer/);
  });
});
