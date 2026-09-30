import { describe, expect, test, vi } from "vitest";
import type { RelayClient } from "../transport/relay_client.js";
import { installOwnerRouter } from "./owner_router.js";

const identity = {
  deviceId: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  endpointId: "11111111-1111-4111-8111-111111111111",
  runtimeInstanceId: "22222222-2222-4222-8222-222222222222",
};

class RelayMock {
  private listener: ((line: string) => void) | null = null;
  on(_event: string, listener: (line: string) => void): void { this.listener = listener; }
  off(): void { this.listener = null; }
  emit(purpose: "pairing" | "session", frame: unknown, payload?: Uint8Array): void {
    this.listener?.(JSON.stringify({
      type: "route",
      purpose,
      device_id: identity.deviceId,
      endpoint_id: identity.endpointId,
      runtime_instance_id: identity.runtimeInstanceId,
      source_owner_id: "owner",
      ct: (payload ? Buffer.from(payload) : Buffer.from(JSON.stringify(frame))).toString("base64"),
    }));
  }
}

describe("installOwnerRouter", () => {
  test("rejects corrupted UTF-8 before pairing or unbound owner delivery", async () => {
    const relay = new RelayMock();
    const handlePairRequest = vi.fn();
    const routeClientFrame = vi.fn();
    const attachOwner = vi.fn();
    const findKnownOwner = vi.fn(async () => true);
    installOwnerRouter(relay as unknown as RelayClient, {
      isCurrent: () => true, routeIdentity: () => identity, hasOwner: () => false,
      findKnownOwner, attachOwner, routeClientFrame, handlePairRequest,
    });
    const pair = { protocol_version: 2, type: "pair_request", id: "pair", code: "ABCD2345", device_name: "X" };
    const hello = { protocol_version: 2, type: "session_hello", id: "X", channel_id: "channel" };
    for (const [purpose, frame] of [["pairing", pair], ["session", hello]] as const) {
      const payload = Buffer.from(JSON.stringify(frame));
      payload[payload.indexOf("X")] = 0xff;
      relay.emit(purpose, frame, payload);
    }
    await Promise.resolve();
    expect(handlePairRequest).not.toHaveBeenCalled();
    expect(findKnownOwner).not.toHaveBeenCalled();
    expect(attachOwner).not.toHaveBeenCalled();
    expect(routeClientFrame).not.toHaveBeenCalled();

    // 合法替换字符本身仍是允许的文本；只拒绝损坏的编码字节。
    relay.emit("pairing", { ...pair, device_name: "中文�🙂" });
    expect(handlePairRequest).toHaveBeenCalledWith(relay, "owner", expect.objectContaining({ device_name: "中文�🙂" }));
    relay.emit("session", hello);
    await Promise.resolve();
    expect(routeClientFrame).toHaveBeenCalledWith("owner", hello);
  });

  test("rejects session frames carried through the pairing ACL exception", async () => {
    const relay = new RelayMock();
    const handlePairRequest = vi.fn();
    const routeClientFrame = vi.fn();
    installOwnerRouter(relay as unknown as RelayClient, {
      isCurrent: () => true,
      routeIdentity: () => identity,
      hasOwner: () => false,
      findKnownOwner: async () => true,
      attachOwner: vi.fn(),
      routeClientFrame,
      handlePairRequest,
    });
    relay.emit("pairing", { protocol_version: 2, type: "session_hello", id: "bypass", channel_id: "channel" });
    relay.emit("session", { protocol_version: 2, type: "pair_request", id: "wrong", code: "ABCD2345", device_name: "Browser" });
    await Promise.resolve();
    expect(routeClientFrame).not.toHaveBeenCalled();
    expect(handlePairRequest).not.toHaveBeenCalled();

    relay.emit("pairing", { protocol_version: 2, type: "pair_request", id: "pair", code: "ABCD2345", device_name: "Browser" });
    expect(handlePairRequest).toHaveBeenCalledTimes(1);
  });
});
