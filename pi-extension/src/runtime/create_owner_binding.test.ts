import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { AttachmentStore } from "../attachments/store.js";
import type { RelayClient } from "../transport/relay_client.js";
import { AttachmentDelivery } from "../timeline/attachment_delivery.js";
import { TimelineRuntime } from "../timeline/runtime.js";
import { UserDeliveryBinding, type UserDeliveryTarget } from "../timeline/user_delivery_binding.js";
import { createOwnerBinding } from "./create_owner_binding.js";

test("owner factory preserves legacy image queue and fail-closed upload default", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "reach-attachment-factory-"));
  const manager = SessionManager.inMemory(root);
  const store = new AttachmentStore({ rootDir: root, runtimeId: "runtime", minFreeBytes: 0 });
  const runtime = new TimelineRuntime();
  let target: UserDeliveryTarget | null = null;
  const delivery = new UserDeliveryBinding({ isIdle: () => false, canAcceptNormal: () => true,
    getPi: () => null, getTimeline: () => runtime, getCurrentSessionId: () => manager.getSessionId(),
    getCurrentLeafId: () => manager.getLeafId(), findTarget: () => target, sendFrames: vi.fn() });
  const relay = new EventEmitter() as unknown as RelayClient;
  const onTurn = vi.fn();
  const binding = createOwnerBinding({ relayClient: relay, ownerId: "owner", manager, runtime,
    identity: { deviceId: "host", endpointId: "endpoint", runtimeInstanceId: "runtime" },
    extensionVersion: "1", delivery, attachments: new AttachmentDelivery(store), onFrame: vi.fn(), onTurn });
  target = binding;
  try {
    binding.service.handle({ protocol_version: 2, type: "session_hello", id: "hello", channel_id: "channel" });
    expect(binding.service.handle({ protocol_version: 2, type: "user_message", id: "wire", channel_id: "channel",
      leaf_id: manager.getLeafId(), client_request_id: "request", text: "legacy",
      images: [{ mime: "image/png", data: "eA==" }] })).toMatchObject([
      { status: "accepted" }, { items: [{ text: "legacy", images: [{ mime: "image/png", data: "eA==" }] }] },
    ]);
    expect(onTurn).toHaveBeenCalledWith("request");
    expect(binding.service.handle({ protocol_version: 2, type: "attachment_capabilities_request", id: "caps",
      channel_id: "channel", session_id: manager.getSessionId(), leaf_id: manager.getLeafId() })).toMatchObject([{ code: "unsupported_type" }]);
    expect(relay.listenerCount("message")).toBe(1);
    binding.channel.detach();
    expect(relay.listenerCount("message")).toBe(0);
  } finally {
    delivery.clearAll();
    binding.channel.detach();
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
