import { describe, expect, it } from "vitest";

import {
  DiscoveryBudget,
  DiscoveryCapacityError,
  discoveryBaselineBytes,
  emptyDiscoveryFrameBytes,
  endpointDiscoveryBytes,
} from "./discovery-budget.js";
import { stringifyWire, type RelayEndpointMetadata } from "./wire.js";

const DEVICE = Buffer.alloc(32, 1).toString("base64");
const ENDPOINT = "11111111-1111-4111-8111-111111111111";
const RUNTIME = "22222222-2222-4222-8222-222222222222";

function endpoint(metadata: RelayEndpointMetadata = { kind: "daemon" }) {
  return { endpoint_id: ENDPOINT, runtime_instance_id: RUNTIME, metadata };
}

describe("discovery budget", () => {
  it("uses exact UTF-8 wire bytes and preserves exact integer serialization", () => {
    const metadata = { kind: "daemon" as const, name: "远程 π", pid: 18_446_744_073_709_551_615n };
    const entry = endpoint(metadata);
    const entryBytes = BigInt(Buffer.byteLength(stringifyWire(entry), "utf8")) + 1n;
    const eventBytes = BigInt(Buffer.byteLength(stringifyWire({
      type: "endpoint_announced",
      device_id: DEVICE,
      endpoint_id: ENDPOINT,
      runtime_instance_id: RUNTIME,
      metadata,
    }), "utf8"));
    const conservativeEventBytes = eventBytes - emptyDiscoveryFrameBytes(DEVICE);
    expect(stringifyWire(entry)).toContain('"pid":18446744073709551615');
    expect(endpointDiscoveryBytes(DEVICE, entry)).toBe(entryBytes > conservativeEventBytes ? entryBytes : conservativeEventBytes);
  });

  it("accepts exactly the maximum and rejects one byte over", () => {
    const entryBytes = endpointDiscoveryBytes(DEVICE, endpoint());
    const maximum = discoveryBaselineBytes(1) + entryBytes;
    const exact = new DiscoveryBudget(Number(maximum), 1);
    exact.assertReplacement(0n, entryBytes);
    exact.commitReplacement(0n, entryBytes);
    expect(exact.totalBytes).toBe(maximum);

    const short = new DiscoveryBudget(Number(maximum - 1n), 1);
    expect(() => short.assertReplacement(0n, entryBytes)).toThrow(DiscoveryCapacityError);
  });

  it("rejects a baseline that leaves no endpoint capacity", () => {
    expect(() => new DiscoveryBudget(Number(discoveryBaselineBytes(2)), 2)).toThrow(/baseline/);
  });
});
