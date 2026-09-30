import { stringifyWire, type RelayEndpointMetadata } from "./wire.js";

const SAMPLE_DEVICE_ID = Buffer.alloc(32).toString("base64");

type DiscoveryEndpointInfo = {
  endpoint_id: string;
  runtime_instance_id: string;
  metadata: RelayEndpointMetadata;
};

export class DiscoveryCapacityError extends Error {
  constructor() {
    super("relay discovery capacity exceeded");
    this.name = "DiscoveryCapacityError";
  }
}

export function emptyDiscoveryFrameBytes(deviceId = SAMPLE_DEVICE_ID): bigint {
  return wireBytes({ type: "endpoints", device_id: deviceId, endpoints: [] });
}

export function discoveryBaselineBytes(maxSubscriptions: number): bigint {
  return emptyDiscoveryFrameBytes() * BigInt(maxSubscriptions);
}

export function endpointDiscoveryBytes(deviceId: string, endpoint: DiscoveryEndpointInfo): bigint {
  const snapshotEntryBytes = wireBytes(endpoint) + 1n;
  const emptyFrameBytes = emptyDiscoveryFrameBytes(deviceId);
  const eventBytes = ["endpoint_announced", "endpoint_updated"]
    .map((type) => wireBytes({
      type,
      device_id: deviceId,
      endpoint_id: endpoint.endpoint_id,
      runtime_instance_id: endpoint.runtime_instance_id,
      metadata: endpoint.metadata,
    }));
  const endedBytes = wireBytes({
    type: "endpoint_ended",
    device_id: deviceId,
    endpoint_id: endpoint.endpoint_id,
    runtime_instance_id: endpoint.runtime_instance_id,
  });
  const eventEntryBytes = [...eventBytes, endedBytes]
    .reduce((maximum, bytes) => bytes > maximum ? bytes : maximum, 0n) - emptyFrameBytes;
  return eventEntryBytes > snapshotEntryBytes ? eventEntryBytes : snapshotEntryBytes;
}

export class DiscoveryBudget {
  readonly baselineBytes: bigint;
  private endpointBytes = 0n;
  private readonly maximumBytes: bigint;

  constructor(maxDiscoveryBytes: number, maxSubscriptions: number) {
    this.maximumBytes = BigInt(maxDiscoveryBytes);
    this.baselineBytes = discoveryBaselineBytes(maxSubscriptions);
    if (this.baselineBytes >= this.maximumBytes) {
      throw new Error("discovery baseline must be less than maxDiscoveryBytes");
    }
  }

  get totalBytes(): bigint {
    return this.baselineBytes + this.endpointBytes;
  }

  measure(deviceId: string, endpoint: DiscoveryEndpointInfo): bigint {
    return endpointDiscoveryBytes(deviceId, endpoint);
  }

  assertReplacement(previousBytes: bigint, nextBytes: bigint): void {
    if (previousBytes < 0n || previousBytes > this.endpointBytes) throw new Error("invalid discovery budget replacement");
    if (this.totalBytes - previousBytes + nextBytes > this.maximumBytes) throw new DiscoveryCapacityError();
  }

  commitReplacement(previousBytes: bigint, nextBytes: bigint): void {
    this.endpointBytes = this.endpointBytes - previousBytes + nextBytes;
  }

  release(bytes: bigint): void {
    if (bytes < 0n || bytes > this.endpointBytes) throw new Error("invalid discovery budget release");
    this.endpointBytes -= bytes;
  }
}

function wireBytes(value: unknown): bigint {
  return BigInt(Buffer.byteLength(stringifyWire(value), "utf8"));
}
