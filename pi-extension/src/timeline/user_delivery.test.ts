import { describe, expect, test, vi } from "vitest";
import type { TimelineEvent } from "../protocol/v2/index.js";
import type { Correlation, TimelineStarted } from "./runtime.js";
import { UserDeliveryQueue } from "./user_delivery.js";
import type { TimelineV2Service } from "./v2_service.js";

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function scope(ownerId: string, clientRequestId: string, service = {} as TimelineV2Service) {
  return { ownerId, sessionId: "session-1", leafId: null, service, clientRequestId };
}

function started(correlation: Correlation): TimelineStarted {
  return {
    eventId: `event-${correlation.clientRequestId}`,
    groupId: "group-1",
    role: "user",
    correlation,
    blocks: [],
  };
}

function event(correlation: Correlation): TimelineEvent {
  return {
    kind: "user",
    event_id: `event-${correlation.clientRequestId}`,
    message_id: `event-${correlation.clientRequestId}`,
    group_id: "group-1",
    session_id: "session-1",
    leaf_id: null,
    event_seq: 1,
    timestamp: 1,
    status: "committed",
    blocks: [],
    origin: "pwa",
    sender_ref: correlation.senderRef ?? "owner-1",
    delivery: "normal",
  };
}

describe("UserDeliveryQueue", () => {
  test("holds identical busy payloads by independent correlation until each matching user event", async () => {
    let idle = false;
    const activeServices = new Set<TimelineV2Service>();
    const sent: Array<{ content: string; correlation: Correlation }> = [];
    const queue = new UserDeliveryQueue({
      isIdle: () => idle,
      isCurrent: (value) => activeServices.has(value.service),
      send: (content, correlation) => sent.push({ content: content as string, correlation }),
      onUnknownDelivery: vi.fn(),
    });
    const first = scope("owner-1", "request-first");
    const second = scope("owner-1", "request-second");
    activeServices.add(first.service);
    activeServices.add(second.service);

    expect(queue.enqueue("same text", { origin: "pwa", delivery: "normal", senderRef: "owner-1", clientRequestId: first.clientRequestId }, first)).toBe("queued");
    expect(queue.enqueue("same text", { origin: "pwa", delivery: "normal", senderRef: "owner-1", clientRequestId: second.clientRequestId }, second)).toBe("queued");
    await nextMacrotask();
    expect(sent).toEqual([]);

    idle = true;
    queue.scheduleDrain();
    await nextMacrotask();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ content: "same text", correlation: { clientRequestId: "request-first" } });
    expect(sent[0]!.correlation.deliveryToken).toEqual(expect.any(String));
    expect(queue.onUserStarted({ ...started(sent[0]!.correlation), role: "assistant" })).toBeNull();
    expect(queue.onUserStarted({ ...started(sent[0]!.correlation), role: "toolResult" })).toBeNull();
    expect(queue.onUserStarted(started(sent[0]!.correlation))).toMatchObject({ clientRequestId: "request-first", service: first.service });
    expect(queue.onUserPublished(event(sent[0]!.correlation), sent[0]!.correlation)).toMatchObject({ clientRequestId: "request-first", service: first.service });

    await nextMacrotask();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ content: "same text", correlation: { clientRequestId: "request-second" } });
    expect(sent[1]!.correlation.deliveryToken).not.toBe(sent[0]!.correlation.deliveryToken);
    expect(queue.onUserStarted(started(sent[1]!.correlation))).toMatchObject({ clientRequestId: "request-second", service: second.service });
  });

  test("synchronous SDK failures and missing starts release the queue without reusing another request", async () => {
    let idle = true;
    const service = {} as TimelineV2Service;
    const sent: Correlation[] = [];
    const unknown: string[] = [];
    let throws = true;
    const queue = new UserDeliveryQueue({
      isIdle: () => idle,
      isCurrent: (value) => value.service === service,
      send: (_content, correlation) => {
        sent.push(correlation);
        if (throws) {
          throws = false;
          throw new Error("SDK rejected synchronously");
        }
      },
      onUnknownDelivery: (value) => unknown.push(value.clientRequestId),
      startTimeoutMs: 30,
    });
    const first = scope("owner-1", "sync-failure", service);
    const second = scope("owner-1", "timeout", service);
    const third = scope("owner-1", "after-timeout", service);

    queue.enqueue("first", { origin: "pwa", delivery: "normal", senderRef: "owner-1", clientRequestId: first.clientRequestId }, first);
    queue.enqueue("second", { origin: "pwa", delivery: "normal", senderRef: "owner-1", clientRequestId: second.clientRequestId }, second);
    queue.enqueue("third", { origin: "pwa", delivery: "normal", senderRef: "owner-1", clientRequestId: third.clientRequestId }, third);
    await nextMacrotask();
    expect(sent.map((value) => value.clientRequestId)).toEqual(["sync-failure", "timeout"]);
    expect(unknown).toEqual(["sync-failure"]);

    await vi.waitFor(() => expect(unknown).toEqual(["sync-failure", "timeout"]));
    await vi.waitFor(() => expect(sent.map((value) => value.clientRequestId)).toEqual(["sync-failure", "timeout", "after-timeout"]));
    expect(queue.onUserStarted(started(sent[2]!))).toMatchObject({ clientRequestId: "after-timeout" });

    // A late start must retain its own token and never consume the third request.
    expect(queue.onUserStarted(started(sent[1]!))).toMatchObject({ clientRequestId: "timeout" });
    idle = false;
  });

  test("clearing an active owner drains the next owner without accepting stale callbacks", async () => {
    const serviceA = {} as TimelineV2Service;
    const serviceB = {} as TimelineV2Service;
    const sent: Correlation[] = [];
    const queue = new UserDeliveryQueue({
      isIdle: () => true,
      isCurrent: (value) => value.service === serviceA || value.service === serviceB,
      send: (_content, correlation) => sent.push(correlation),
      onUnknownDelivery: vi.fn(),
    });
    const ownerA = scope("owner-a", "active-owner", serviceA);
    const ownerB = scope("owner-b", "remaining-owner", serviceB);
    queue.enqueue("a", { origin: "pwa", delivery: "normal", senderRef: "owner-a", clientRequestId: ownerA.clientRequestId }, ownerA);
    queue.enqueue("b", { origin: "pwa", delivery: "normal", senderRef: "owner-b", clientRequestId: ownerB.clientRequestId }, ownerB);
    await nextMacrotask();
    expect(sent.map((value) => value.clientRequestId)).toEqual(["active-owner"]);

    queue.clearOwner("owner-a", serviceA);
    await nextMacrotask();
    expect(sent.map((value) => value.clientRequestId)).toEqual(["active-owner", "remaining-owner"]);
    expect(queue.onUserStarted(started(sent[0]!))).toBeNull();
    expect(queue.onUserStarted(started(sent[1]!))).toMatchObject({ clientRequestId: "remaining-owner", service: serviceB });
  });

  test("clearAll and leaf changes release entry and byte budgets without late delivery", async () => {
    let leafId: string | null = null;
    const service = {} as TimelineV2Service;
    const sent: Correlation[] = [];
    const queue = new UserDeliveryQueue({
      isIdle: () => true,
      isCurrent: (value) => value.service === service && value.leafId === leafId,
      send: (_content, correlation) => sent.push(correlation),
      onUnknownDelivery: vi.fn(),
      maxEntries: 1,
      maxBytes: 5,
    });
    const stale = { ...scope("owner-1", "stale", service), leafId };
    expect(queue.enqueue("12345", { origin: "pwa", delivery: "normal", senderRef: "owner-1", clientRequestId: stale.clientRequestId }, stale)).toBe("queued");
    expect(queue.enqueue("x", { origin: "pwa", delivery: "normal", senderRef: "owner-1", clientRequestId: "over-budget" }, stale)).toBe("rejected");
    leafId = "leaf-2";
    queue.clearAll();
    await nextMacrotask();
    expect(sent).toEqual([]);

    const current = { ...scope("owner-1", "current", service), leafId };
    expect(queue.enqueue("12345", { origin: "pwa", delivery: "normal", senderRef: "owner-1", clientRequestId: current.clientRequestId }, current)).toBe("queued");
    queue.clearOwner("owner-1", service);
    await nextMacrotask();
    expect(sent).toEqual([]);
  });

  test("drops only the detached owner and rejects payloads above the bounded queue budget", async () => {
    let idle = false;
    const serviceA = {} as TimelineV2Service;
    const serviceB = {} as TimelineV2Service;
    const sent: Correlation[] = [];
    const queue = new UserDeliveryQueue({
      isIdle: () => idle,
      isCurrent: (value) => value.service === serviceA || value.service === serviceB,
      send: (_content, correlation) => sent.push(correlation),
      onUnknownDelivery: vi.fn(),
      maxEntries: 1,
      maxBytes: 16,
    });
    const ownerA = scope("owner-a", "owner-a-request", serviceA);
    const ownerB = scope("owner-b", "owner-b-request", serviceB);

    expect(queue.enqueue("payload", { origin: "pwa", delivery: "normal", senderRef: "owner-a", clientRequestId: ownerA.clientRequestId }, ownerA)).toBe("queued");
    expect(queue.enqueue("payload", { origin: "pwa", delivery: "normal", senderRef: "owner-b", clientRequestId: ownerB.clientRequestId }, ownerB)).toBe("rejected");
    queue.clearOwner("owner-a", serviceA);
    expect(queue.enqueue("payload", { origin: "pwa", delivery: "normal", senderRef: "owner-b", clientRequestId: ownerB.clientRequestId }, ownerB)).toBe("queued");

    idle = true;
    queue.scheduleDrain();
    await nextMacrotask();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ clientRequestId: "owner-b-request", senderRef: "owner-b" });
    queue.clearOwner("owner-b", serviceB);
    expect(queue.onUserStarted(started(sent[0]!))).toBeNull();
  });

  test("isolates snapshots by owner and makes in-flight entries non-editable and non-clearable", async () => {
    let idle = false;
    const serviceA = { sessionId: "session-1", leafId: null } as TimelineV2Service;
    const serviceB = { sessionId: "session-1", leafId: null } as TimelineV2Service;
    const sent: Correlation[] = [];
    const queue = new UserDeliveryQueue({
      isIdle: () => idle,
      isCurrent: (value) => value.service === serviceA || value.service === serviceB,
      send: (_content, correlation) => sent.push(correlation),
      onUnknownDelivery: vi.fn(),
      clock: () => 1234,
    });
    const ownerA = scope("owner-a", "request-a", serviceA);
    const ownerB = scope("owner-b", "request-b", serviceB);
    queue.enqueue("alpha", { origin: "pwa", delivery: "normal", senderRef: "owner-a", clientRequestId: ownerA.clientRequestId }, ownerA);
    queue.enqueue("bravo", { origin: "pwa", delivery: "normal", senderRef: "owner-b", clientRequestId: ownerB.clientRequestId }, ownerB);

    expect(queue.snapshot("owner-a", serviceA)).toEqual([{
      id: "request-a",
      text: "alpha",
      sender_ref: "owner-a",
      editable: true,
      created_at: 1234,
    }]);
    expect(queue.snapshot("owner-a", serviceB)).toEqual([]);
    expect(queue.clearQueued("owner-a", serviceA, "request-b")).toEqual([]);

    idle = true;
    queue.scheduleDrain();
    await nextMacrotask();
    expect(queue.snapshot("owner-a", serviceA)[0]).toMatchObject({ id: "request-a", editable: false });
    expect(queue.clearQueued("owner-a", serviceA, "request-a")).toEqual([]);
    expect(queue.snapshot("owner-b", serviceB)[0]).toMatchObject({ id: "request-b", editable: true });
    queue.clearAll();
  });

  test("steers a queued attachment once and restores it after a synchronous SDK failure", () => {
    const service = { sessionId: "session-1", leafId: null } as TimelineV2Service;
    const attempts: Array<{ content: unknown; options: unknown }> = [];
    let fail = true;
    const queue = new UserDeliveryQueue({
      isIdle: () => false,
      isCurrent: (value) => value.service === service,
      send: (content, _correlation, options) => {
        attempts.push({ content, options });
        if (fail) {
          fail = false;
          throw new Error("SDK rejected synchronously");
        }
      },
      onUnknownDelivery: vi.fn(),
      clock: () => 55,
    });
    const target = scope("owner-1", "request-1", service);
    const content = [
      { type: "image" as const, data: "QUJD", mimeType: "image/png" },
      { type: "text" as const, text: "inspect" },
    ];
    const correlation = { origin: "pwa" as const, delivery: "normal" as const, senderRef: "owner-1", clientRequestId: target.clientRequestId };
    expect(queue.enqueue(content, correlation, target)).toBe("queued");
    expect(queue.enqueue(content, correlation, target)).toBe("duplicate");
    expect(queue.enqueue("different", correlation, target)).toBe("conflict");

    expect(queue.steer("owner-1", service, "request-1").kind).toBe("failed");
    expect(queue.snapshot("owner-1", service)[0]).toMatchObject({
      id: "request-1",
      text: "inspect",
      images: [{ data: "QUJD", mime: "image/png" }],
      editable: true,
      created_at: 55,
    });
    expect(queue.steer("owner-1", service, "request-1").kind).toBe("sent");
    expect(queue.steer("owner-1", service, "request-1").kind).toBe("missing");
    expect(queue.steer("owner-2", service, "request-1").kind).toBe("missing");
    expect(attempts).toEqual([
      { content, options: { deliverAs: "steer" } },
      { content, options: { deliverAs: "steer" } },
    ]);
    expect(queue.snapshot("owner-1", service)).toEqual([]);
  });

  test("rejects an attachment before enqueue when one snapshot item cannot fit", () => {
    const service = { sessionId: "session-1", leafId: null } as TimelineV2Service;
    const checked = vi.fn(() => false);
    const queue = new UserDeliveryQueue({
      isIdle: () => false,
      isCurrent: (value) => value.service === service,
      send: vi.fn(),
      onUnknownDelivery: vi.fn(),
      canQueueItem: checked,
    });
    const target = scope("owner-1", "large-image", service);
    const content = [
      { type: "image" as const, data: "A".repeat(512), mimeType: "image/png" },
      { type: "text" as const, text: "caption" },
    ];
    expect(queue.enqueue(content, { origin: "pwa", delivery: "normal", senderRef: "owner-1", clientRequestId: target.clientRequestId }, target)).toBe("rejected");
    expect(checked).toHaveBeenCalledWith(target, expect.objectContaining({
      id: "large-image",
      images: [{ data: "A".repeat(512), mime: "image/png" }],
    }));
    expect(queue.snapshot("owner-1", service)).toEqual([]);
  });
});
