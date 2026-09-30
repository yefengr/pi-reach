import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import type { ClientFrame, ServerFrame } from "../protocol/v2/index.js";
import { TimelineRuntime } from "./runtime.js";
import { UserDeliveryBinding, type UserDeliveryTarget } from "./user_delivery_binding.js";
import { TimelineV2Service } from "./v2_service.js";

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function hello(channelId = "channel-1"): Extract<ClientFrame, { type: "session_hello" }> {
  return { protocol_version: 2, type: "session_hello", id: "hello-1", channel_id: channelId };
}

function user(leafId: string | null): Extract<ClientFrame, { type: "user_message" }> {
  return {
    protocol_version: 2,
    type: "user_message",
    id: "wire-1",
    channel_id: "channel-1",
    leaf_id: leafId,
    client_request_id: "request-1",
    text: "hello",
  };
}

describe("UserDeliveryBinding", () => {
  test("sends started/status before removing a normal in-flight item from the snapshot", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    const targets = new Map<string, UserDeliveryTarget>();
    const outbound: ServerFrame[] = [];
    let service!: TimelineV2Service;
    let binding!: UserDeliveryBinding;
    const pi = {
      sendUserMessage: vi.fn(() => {
        const started = runtime.onMessageStart({ role: "user", content: "hello", timestamp: 1 }, session);
        if (started) binding.onStarted(started);
      }),
    } as unknown as ExtensionAPI;

    binding = new UserDeliveryBinding({
      isIdle: () => true,
      canAcceptNormal: () => true,
      getPi: () => pi,
      getTimeline: () => runtime,
      getCurrentSessionId: () => session.getSessionId(),
      getCurrentLeafId: () => service.leafId,
      findTarget: (ownerId) => targets.get(ownerId) ?? null,
      sendFrames: (_ownerId, frames) => outbound.push(...frames),
    });
    service = new TimelineV2Service({
      sessionManager: session,
      senderRef: "owner-1",
      runtime,
      onUserMessage: (frame, correlation) => binding.submit(frame, correlation, {
        ownerId: "owner-1",
        sessionId: session.getSessionId(),
        leafId: service.leafId,
        service,
        clientRequestId: frame.client_request_id,
      }),
      onQueueSnapshot: () => binding.snapshot("owner-1", service),
    });
    targets.set("owner-1", { service, sessionId: session.getSessionId(), leafId: session.getLeafId() ?? null });
    service.handle(hello());

    expect(service.handle(user(service.leafId))).toEqual([
      expect.objectContaining({ type: "user_message_status", status: "accepted" }),
      expect.objectContaining({ type: "queued_message_state", items: [expect.objectContaining({ id: "request-1", editable: true })] }),
    ]);
    await nextMacrotask();

    expect(pi.sendUserMessage).toHaveBeenCalledWith("hello", undefined);
    expect(outbound.map((frame) => frame.type)).toEqual([
      "queued_message_state",
      "user_message_status",
      "user_message_started",
      "queued_message_state",
    ]);
    expect(outbound[0]).toMatchObject({ type: "queued_message_state", items: [{ id: "request-1", editable: false }] });
    expect(outbound[1]).toMatchObject({ type: "user_message_status", status: "accepted" });
    expect(outbound[2]).toMatchObject({ type: "user_message_started", message: { sender_ref: "owner-1" } });
    expect(outbound[3]).toMatchObject({ type: "queued_message_state", items: [] });
  });

  test("isolates owners and hands a queued target to steer at most once", () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    const targets = new Map<string, UserDeliveryTarget>();
    let fail = true;
    const sendUserMessage = vi.fn(() => {
      if (fail) {
        fail = false;
        throw new Error("sync failure");
      }
    });
    const binding = new UserDeliveryBinding({
      isIdle: () => false,
      canAcceptNormal: () => true,
      getPi: () => ({ sendUserMessage } as unknown as ExtensionAPI),
      getTimeline: () => runtime,
      getCurrentSessionId: () => session.getSessionId(),
      getCurrentLeafId: () => session.getLeafId() ?? null,
      findTarget: (ownerId) => targets.get(ownerId) ?? null,
      sendFrames: vi.fn(),
    });
    const serviceA = new TimelineV2Service({ sessionManager: session, senderRef: "owner-a", runtime, onUserMessage: () => false });
    const serviceB = new TimelineV2Service({ sessionManager: session, senderRef: "owner-b", runtime, onUserMessage: () => false });
    targets.set("owner-a", { service: serviceA, sessionId: session.getSessionId(), leafId: session.getLeafId() ?? null });
    targets.set("owner-b", { service: serviceB, sessionId: session.getSessionId(), leafId: session.getLeafId() ?? null });

    const frameA = { ...user(session.getLeafId() ?? null), client_request_id: "target-1", text: "alpha" };
    const frameB = { ...user(session.getLeafId() ?? null), client_request_id: "target-1", text: "bravo" };
    expect(binding.submit(frameA, { origin: "pwa", delivery: "normal" }, {
      ownerId: "owner-a", sessionId: session.getSessionId(), leafId: session.getLeafId() ?? null, service: serviceA, clientRequestId: frameA.client_request_id,
    })).toBe("queued");
    expect(binding.submit(frameB, { origin: "pwa", delivery: "normal" }, {
      ownerId: "owner-b", sessionId: session.getSessionId(), leafId: session.getLeafId() ?? null, service: serviceB, clientRequestId: frameB.client_request_id,
    })).toBe("queued");

    expect(binding.snapshot("owner-a", serviceA)[0]).toMatchObject({
      type: "queued_message_state",
      items: [{ id: "target-1", text: "alpha", sender_ref: "owner-a" }],
    });
    expect(binding.snapshot("owner-a", serviceB)[0]).toMatchObject({ items: [] });
    expect(binding.steerQueued("owner-a", serviceA, "target-1").kind).toBe("failed");
    expect(binding.snapshot("owner-a", serviceA)[0]).toMatchObject({ items: [{ id: "target-1", editable: true }] });
    expect(binding.steerQueued("owner-a", serviceA, "target-1").kind).toBe("sent");
    expect(binding.steerQueued("owner-a", serviceA, "target-1").kind).toBe("missing");
    expect(binding.snapshot("owner-b", serviceB)[0]).toMatchObject({ items: [{ id: "target-1", text: "bravo" }] });
    expect(sendUserMessage).toHaveBeenNthCalledWith(1, "alpha", { deliverAs: "steer" });
    expect(sendUserMessage).toHaveBeenNthCalledWith(2, "alpha", { deliverAs: "steer" });
  });
});
