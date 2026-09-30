import { PAIR_TTL_MAX_MS } from "@pi-reach/protocol/outer";
import { afterEach, describe, expect, test, vi } from "vitest";

import { PeerRegistry, type Outbound } from "../../../relay/src/registry.js";
import type { HostHello } from "../../../relay/src/wire.js";
import { QRSession, clampPairTtlMs } from "./qr.js";

const ENDPOINT_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME_ID = "22222222-2222-4222-8222-222222222222";

function identity(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64");
}

function sink(): Outbound & { frames: Array<Record<string, unknown>> } {
  const frames: Array<Record<string, unknown>> = [];
  return { frames, send: (line) => { frames.push(JSON.parse(line) as Record<string, unknown>); return true; }, isOpen: () => true };
}

function host(deviceId: string): HostHello {
  return {
    role: "host",
    deviceId,
    endpointId: ENDPOINT_ID,
    runtimeInstanceId: RUNTIME_ID,
    metadata: { kind: "interactive", name: "ttl-contract" },
    authorizedOwnerIds: new Set(),
  };
}

afterEach(() => vi.useRealTimers());

describe("pairing TTL contract", () => {
  test("resolves a clamped QR invite through Relay and reports expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));

    const session = new QRSession();
    const ttlMs = clampPairTtlMs(600_000);
    const invite = session.issueCode(ttlMs);
    const registry = new PeerRegistry(() => Date.now());
    const device = identity(1);
    const owner = identity(2);
    const ownerSink = sink();
    const ownerConn = registry.registerOwner(owner, ownerSink);
    const hostConn = registry.registerHost(host(device), sink());

    expect(ttlMs).toBe(PAIR_TTL_MAX_MS);
    expect(registry.publishPairingOffer(device, ENDPOINT_ID, hostConn, {
      code: invite.code,
      endpointId: ENDPOINT_ID,
      runtimeInstanceId: RUNTIME_ID,
      expiresAt: invite.expiresAt,
    })).toBe(true);
    expect(registry.resolvePairingCode(owner, ownerConn, { requestId: "resolve", code: invite.code })).toBe("resolved");
    expect(ownerSink.frames.pop()).toEqual({
      type: "pairing_target",
      in_reply_to: "resolve",
      code: invite.code,
      device_id: device,
      endpoint_id: ENDPOINT_ID,
      runtime_instance_id: RUNTIME_ID,
    });

    vi.setSystemTime(invite.expiresAt);
    expect(registry.resolvePairingCode(owner, ownerConn, { requestId: "expired", code: invite.code })).toBe("expired_code");
    expect(ownerSink.frames.pop()).toEqual({
      type: "pairing_code_error",
      in_reply_to: "expired",
      reason: "expired_code",
    });
  });
});
