import { describe, expect, test } from "vitest";
import { V2SessionState } from "./session_state.js";

describe("V2SessionState", () => {
  test("tracks independent logical channels", () => {
    const state = new V2SessionState({ sessionId: "session", leafId: "g1", clock: () => 1 });
    expect(state.hello("owner", "tab-a")).toMatchObject({ senderRef: "owner", channelId: "tab-a", ready: true });
    expect(state.hello("owner", "tab-b")).toMatchObject({ channelId: "tab-b" });
    expect(state.snapshot().channels).toHaveLength(2);
    state.removeChannel("owner", "tab-a");
    expect(state.get("owner", "tab-a")).toBeUndefined();
    expect(state.get("owner", "tab-b")).toBeDefined();
  });

  test("replays equal payload and rejects conflicting payload", () => {
    const state = new V2SessionState({ sessionId: "session", leafId: "g1", clock: () => 1 });
    const request = { senderRef: "owner", clientRequestId: "r1", attemptId: "a1", payload: { text: "hello", images: [], streaming_behavior: "steer" } };
    const first = state.begin(request);
    expect(first.kind).toBe("new");
    const accepted = state.update(first.record.key, "accepted", { messageId: "m1", groupId: "g" });
    expect(accepted?.status).toBe("accepted");
    expect(state.begin({ ...request, payload: { streaming_behavior: "steer", images: [], text: "hello" } })).toMatchObject({ kind: "replay", record: { status: "accepted", messageId: "m1" } });
    expect(state.begin({ ...request, payload: { ...request.payload, text: "different" } }).kind).toBe("conflict");
    expect(state.begin({
      ...request,
      payload: { ...request.payload, images: [{ data: "REVG", mime: "image/png" }] },
    }).kind).toBe("conflict");
  });

  test("generation change clears old records", () => {
    const state = new V2SessionState({ sessionId: "session", leafId: "g1", clock: () => 1 });
    const first = state.begin({ senderRef: "owner", clientRequestId: "r1", attemptId: "a1", payload: { text: "x" } });
    state.setScope("session", "g2");
    expect(state.leafId).toBe("g2");
    expect(state.getRecord(first.record.key)).toBeUndefined();
    expect(state.begin({ senderRef: "owner", clientRequestId: "r1", attemptId: "a1", payload: { text: "x" } }).kind).toBe("new");
  });

  test("expires entries and evicts oldest records by capacity", () => {
    let now = 0;
    const state = new V2SessionState({ sessionId: "session", leafId: "g1", maxEntries: 2, ttlMs: 10, clock: () => now });
    const one = state.begin({ senderRef: "owner", clientRequestId: "one", attemptId: "a1", payload: 1 });
    state.begin({ senderRef: "owner", clientRequestId: "two", attemptId: "a2", payload: 2 });
    state.begin({ senderRef: "owner", clientRequestId: "three", attemptId: "a3", payload: 3 });
    expect(state.getRecord(one.record.key)).toBeUndefined();
    now = 11;
    expect(state.snapshot().records).toHaveLength(0);
  });

  test("retains rejection and admits each new attempt without payload changes", () => {
    const state = new V2SessionState({ sessionId: "session", leafId: "g1" });
    const request = { senderRef: "owner", clientRequestId: "r", attemptId: "a1", payload: "x" };
    const { record } = state.begin(request);
    state.reject(record.key, "a1", "queue_full", true);
    expect(state.begin(request)).toMatchObject({ kind: "replay", record: { status: "rejected", attemptId: "a1", rejectCode: "queue_full", retryable: true } });
    expect(state.begin({ ...request, attemptId: "a2", payload: "changed" }).kind).toBe("conflict");
    expect(state.begin({ ...request, attemptId: "a2" })).toMatchObject({ kind: "retry", record: { status: "received", attemptId: "a2" } });
    expect(state.begin({ ...request, attemptId: "a2" }).kind).toBe("replay");
    state.reject(record.key, "a2", "queue_full", true);
    expect(state.begin({ ...request, attemptId: "a2" })).toMatchObject({ kind: "replay", record: { status: "rejected", attemptId: "a2", retryable: true } });
    expect(state.begin({ ...request, attemptId: "a3" })).toMatchObject({ kind: "retry", record: { status: "received", attemptId: "a3" } });
    expect(state.begin({ ...request, attemptId: "a3" }).kind).toBe("replay");
  });

  test("a new attempt cannot bypass a non-retryable rejection", () => {
    const state = new V2SessionState({ sessionId: "session", leafId: "g1" });
    const request = { senderRef: "owner", clientRequestId: "r", attemptId: "a1", payload: "x" };
    const { record } = state.begin(request);
    state.reject(record.key, "a1", "invalid_target", false);
    expect(state.begin({ ...request, attemptId: "a2" })).toMatchObject({ kind: "replay", record: {
      status: "rejected", attemptId: "a1", retryable: false,
    } });
  });

  test("only cancels or rejects records before possible delivery", () => {
    for (const status of ["received", "queued", "accepted", "committed", "unknown_delivery", "cancelled"] as const) {
      const state = new V2SessionState({ sessionId: "session", leafId: "g1" });
      const { record } = state.begin({ senderRef: "owner", clientRequestId: "r", attemptId: "a", payload: "x" });
      state.update(record.key, status);
      const cancellable = status === "received" || status === "queued";
      expect(state.markCancelled(record.key)?.status).toBe(cancellable ? "cancelled" : status);
      expect(state.reject(record.key, "a", "queue_full", true)?.status).toBe(cancellable ? "cancelled" : status);
      expect(state.begin({ senderRef: "owner", clientRequestId: "r", attemptId: "b", payload: "x" }).kind).toBe("replay");
    }
  });

  test("cancellation tombstones remain bounded, scoped and cannot admit arbitrary payloads", () => {
    let now = 0;
    const state = new V2SessionState({ sessionId: "session", leafId: "g1", maxEntries: 2, ttlMs: 10, clock: () => now });
    const request = { senderRef: "owner", clientRequestId: "r", attemptId: "a", payload: "x" };
    state.markCancelledByClientRequest("owner", "r");
    now = 9;
    expect(state.begin({ ...request, payload: "arbitrary" })).toMatchObject({ kind: "replay", record: { status: "cancelled", fingerprint: null, touchedAt: 0 } });
    expect(state.findByClientRequest("other", "r")).toBeUndefined();
    now = 10;
    expect(state.findByClientRequest("owner", "r")).toBeUndefined();
    state.markCancelledByClientRequest("owner", "r");
    state.markCancelledByClientRequest("other", "r");
    state.markCancelledByClientRequest("owner", "new");
    expect(state.snapshot().records).toHaveLength(2);
    expect(state.findByClientRequest("owner", "r")).toBeUndefined();
    state.removeOwner("other");
    expect(state.findByClientRequest("other", "r")).toBeUndefined();
    state.setScope("session", "g2");
    expect(state.findByClientRequest("owner", "new")).toBeUndefined();
    state.markCancelledByClientRequest("owner", "r");
    state.setScope("replacement", "g2");
    expect(state.findByClientRequest("owner", "r")).toBeUndefined();
    expect(state.begin(request).kind).toBe("new");
  });

  test.each([7, 8])("preserves cancellation when TTL expires during the operation at tick %s", (startTick) => {
    let now = 0;
    let advance = false;
    const state = new V2SessionState({ sessionId: "session", leafId: "g1", ttlMs: 10, clock: () => advance ? now++ : now });
    const request = { senderRef: "owner", clientRequestId: "r", attemptId: "a", payload: "x" };
    const { record } = state.begin(request);
    state.update(record.key, "queued");
    now = startTick;
    advance = true;
    // 分别让旧记录在 update 或 getRecord 的清理中到期，成功取消仍须留下新证据。
    const cancelled = state.markCancelledByClientRequest("owner", "r");
    expect(cancelled).toMatchObject({ status: "cancelled", fingerprint: null });
    expect(cancelled!.touchedAt).toBeGreaterThanOrEqual(10);
    expect(state.findByClientRequest("owner", "r")?.status).toBe("cancelled");
    expect(state.begin({ ...request, attemptId: "b", payload: "changed" })).toMatchObject({ kind: "replay", record: { status: "cancelled" } });
  });

  test.each(["accepted", "committed", "unknown_delivery"] as const)("cancellation cannot downgrade %s evidence", (status) => {
    const state = new V2SessionState({ sessionId: "session", leafId: "g1" });
    const request = { senderRef: "owner", clientRequestId: "r", attemptId: "a", payload: "x" };
    const { record } = state.begin(request);
    state.update(record.key, status, { messageId: "message" });
    expect(state.markCancelledByClientRequest("owner", "r")).toMatchObject({ status, fingerprint: record.fingerprint, messageId: "message" });
    expect(state.begin({ ...request, payload: "changed" }).kind).toBe("conflict");
  });

  test("looks across native leaf advances without touching TTL, returning copies or creating records", () => {
    let now = 0;
    const state = new V2SessionState({ sessionId: "session", leafId: "g1", ttlMs: 10, clock: () => now });
    const { record } = state.begin({ senderRef: "owner", clientRequestId: "r", attemptId: "a", payload: "x" });
    // 普通 append 不调用 setScope；模拟服务持有旧 leaf key、当前 key 已前进的查找路径。
    Object.assign(state, { leafIdValue: "g2" });
    now = 9;
    const found = state.findByClientRequest("owner", "r");
    expect(found).toMatchObject({ key: record.key, leafId: "g1", touchedAt: 0 });
    if (found) found.status = "cancelled";
    expect(state.getRecord(record.key)?.status).toBe("received");
    expect(state.findByClientRequest("other", "r")).toBeUndefined();
    expect(state.findByClientRequest("owner", "missing")).toBeUndefined();
    expect(state.snapshot().records).toHaveLength(1);
    now = 10;
    expect(state.findByClientRequest("owner", "r")).toBeUndefined();
    expect(state.getRecord(record.key)).toBeUndefined();
  });

  test("removes all owner state", () => {
    const state = new V2SessionState({ sessionId: "session", leafId: "g1", clock: () => 1 });
    state.hello("owner", "a");
    state.hello("other", "b");
    state.begin({ senderRef: "owner", clientRequestId: "r", attemptId: "a1", payload: "x" });
    state.begin({ senderRef: "other", clientRequestId: "r", attemptId: "a1", payload: "x" });
    state.removeOwner("owner");
    expect(state.snapshot().channels.map((channel) => channel.senderRef)).toEqual(["other"]);
    expect(state.snapshot().records.map((record) => record.senderRef)).toEqual(["other"]);
  });
});
