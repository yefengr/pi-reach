import { afterEach, expect, test, vi } from "vitest";
import type { ServerFrame } from "../pi-reach/protocol-v2/frames";
import type { TimelineEvent } from "../pi-reach/protocol-v2/schema";
import { DELIVERY_STATUS_QUERY_TIMEOUT_MS, TimelineRuntime, type TimelineScope } from "./timeline-runtime";

const scope: TimelineScope = { deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime", sessionId: "session", leafId: "leaf", selfSenderRef: "self", channelId: "channel" };
type Status = Extract<ServerFrame, { type: "user_message_status" }>;
const positive = <S extends "accepted" | "committed">(status: S): { status: S; message_id: string } => ({ status, message_id: "formal" });
function setup(expired = true) {
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const runtime = new TimelineRuntime();
  runtime.beginLive(scope, 0);
  const sent = runtime.sendUser("hello")!;
  runtime.markUnknownDelivery(sent.frame.client_request_id);
  const pending = runtime.pendingItems[0];
  const query = runtime.requestDeliveryStatus(pending.clientRequestId)!;
  if (expired) {
    vi.mocked(Date.now).mockReturnValue(1_000 + DELIVERY_STATUS_QUERY_TIMEOUT_MS);
    runtime.expireDeliveryStatusQueries();
    expect(pending.statusQuery).toBeUndefined();
  }
  const reply = (result: Partial<Status>, requestId = query.frame.id): Status => ({
    protocol_version: 2, type: "user_message_status", target_channel_id: scope.channelId,
    session_id: scope.sessionId, leaf_id: scope.leafId, in_reply_to: requestId,
    client_request_id: pending.clientRequestId, status: "not_found", ...result,
  } as Status);
  const formal: TimelineEvent = { event_id: "formal", message_id: "formal", event_seq: 1, session_id: scope.sessionId,
    leaf_id: "advanced-leaf", timestamp: 2, group_id: "group", kind: "user", blocks: [{ type: "text", text: "hello" }],
    origin: "pwa", sender_ref: scope.selfSenderRef, delivery: "normal", status: "committed" };
  return { runtime, sent, pending, query, reply, formal };
}
afterEach(() => vi.restoreAllMocks());

test.each([
  [true, "accepted", true], [true, "committed", true], [true, "accepted", false], [true, "committed", false],
  [false, "accepted", true], [false, "committed", true], [false, "accepted", false], [false, "committed", false],
] as const)("delivery query expired=%s %s eventFirst=%s merges one bubble and observes once", (expired, status, eventFirst) => {
  const { runtime, pending, reply, formal } = setup(expired);
  if (eventFirst) expect(runtime.commit(formal).items).toHaveLength(2);
  const receipt = runtime.receive(reply(positive(status)));
  const change = eventFirst ? receipt : runtime.commit(formal);
  expect(change.items).toHaveLength(1);
  expect(change.items[0].kind).toBe("event");
  expect(change.observed).toEqual([expect.objectContaining({ type: "user_message_observed", client_request_id: pending.clientRequestId, message_id: "formal" })]);
  expect(runtime.receive(reply(positive(status))).observed).toEqual([]);
  expect(runtime.pendingItems).toEqual([]);
});

test.each(["received", "accepted", "unknown_delivery", "not_found", "cancelled", "rejected"] as const)("expired delivery query applies fresh %s without resending", (status) => {
  const { runtime, pending, reply } = setup();
  const result = status === "rejected" ? { status, code: "queue_full" as const, retryable: false } : { status };
  runtime.receive(reply(result));
  expect(pending.delivery).toBe(status === "not_found" ? "unknown_delivery" : status === "rejected" ? "failed" : status);
  expect(runtime.retryFailed(pending.clientRequestId)).toBeNull();
});

test.each([true, false])("delivery query expired=%s rejects stale weak and negative evidence in the same millisecond", (expired) => {
  const { runtime, sent, pending, reply, formal } = setup(expired);
  runtime.receive(reply({ status: "accepted" }, sent.frame.id));
  for (const status of ["received", "accepted", "unknown_delivery", "not_found", "cancelled", "rejected"] as const) {
    const before = JSON.stringify(pending);
    runtime.receive(reply(status === "rejected" ? { status, code: "queue_full", retryable: true } : { status }));
    expect(JSON.stringify(pending)).toBe(before);
  }
  // 新证据不妨碍同一查询用肯定的 message_id 关联原消息。
  runtime.commit(formal);
  const change = runtime.receive(reply(positive("committed")));
  expect(change.items).toHaveLength(1);
  expect(change.observed).toHaveLength(1);
});

test.each(["accepted", "committed", "cancelled", "rejected", "unknown_delivery", "not_found"] as const)("older delivery query %s cannot clear or settle a newer query", (status) => {
  const { runtime, pending, reply } = setup();
  const next = runtime.requestDeliveryStatus(pending.clientRequestId)!;
  const before = JSON.stringify(pending);
  runtime.receive(reply(status === "rejected" ? { status, code: "queue_full", retryable: true }
    : status === "accepted" || status === "committed" ? positive(status) : { status }));
  expect(JSON.stringify(pending)).toBe(before);
  expect(pending.statusQuery?.requestId).toBe(next.frame.id);
  runtime.receive(reply(positive("accepted"), next.frame.id));
  expect(pending.messageId).toBe("formal");
});

test.each(["attempt", "operation"] as const)("expired delivery query cannot settle a newer %s", (boundary) => {
  const { runtime, pending, reply } = setup();
  if (boundary === "attempt") {
    runtime.markDeliveryFailed(pending.clientRequestId, "transport_unavailable", true);
    expect(runtime.retryFailed(pending.clientRequestId)).not.toBeNull();
  } else {
    runtime.receive({ protocol_version: 2, type: "queued_message_state", session_id: scope.sessionId, leaf_id: scope.leafId,
      snapshot_id: "queue", chunk_index: 0, final: true,
      items: [{ id: pending.clientRequestId, text: "hello", sender_ref: scope.selfSenderRef, editable: true, created_at: 1 }] });
    expect(runtime.actOnQueued(pending.clientRequestId, "cancel")).not.toBeNull();
  }
  const before = JSON.stringify(pending);
  runtime.receive(reply(positive("committed")));
  runtime.receive(reply({ status: "cancelled" }));
  runtime.receive(reply({ status: "rejected", code: "queue_full", retryable: true }));
  expect(JSON.stringify(pending)).toBe(before);
});

test.each(["disconnect", "channelId", "deviceId", "endpointId", "runtimeInstanceId", "sessionId", "selfSenderRef", "reset"] as const)("expired delivery query cannot cross %s", (boundary) => {
  const { runtime, pending, reply } = setup();
  if (boundary === "disconnect") runtime.markDisconnected();
  else if (boundary === "reset") runtime.invalidateScope();
  else runtime.setScope({ ...scope, [boundary]: "different" });
  const before = JSON.stringify(pending);
  expect(runtime.receive(reply(positive("committed"))).observed).toEqual([]);
  expect(JSON.stringify(pending)).toBe(before);
});

test("expired delivery query enforces client and channel identity and association TTL", () => {
  const { runtime, pending, reply } = setup();
  const before = JSON.stringify(pending);
  runtime.receive(reply({ ...positive("committed"), client_request_id: "other" }));
  runtime.receive(reply({ ...positive("committed"), target_channel_id: "other" }));
  vi.mocked(Date.now).mockReturnValue(61_000);
  runtime.receive(reply(positive("committed")));
  expect(JSON.stringify(pending)).toBe(before);
});

test("expired delivery query associations retain at most 128 entries for normal receipts", () => {
  const { runtime, pending, reply } = setup();
  const other = runtime.sendUser("another message")!;
  runtime.markUnknownDelivery(other.frame.client_request_id);
  let latest: ReturnType<TimelineRuntime["requestDeliveryStatus"]> = null;
  for (let index = 0; index < 128; index++) {
    latest = runtime.requestDeliveryStatus(other.frame.client_request_id);
    runtime.expireDeliveryStatusQueries(Date.now() + DELIVERY_STATUS_QUERY_TIMEOUT_MS);
  }
  // 首条仍是该消息的最新查询，仅因全局容量被回收，而不是被同消息的新查询挡住。
  const before = JSON.stringify(pending);
  runtime.receive(reply(positive("committed")));
  expect(JSON.stringify(pending)).toBe(before);
  runtime.receive(reply({ ...positive("committed"), client_request_id: other.frame.client_request_id }, latest!.frame.id));
  expect(runtime.pendingItems.find(item => item.clientRequestId === other.frame.client_request_id)?.messageId).toBe("formal");
});

test.each(["accepted", "committed"] as const)("reconnected delivery query merges late %s across ordinary leaf advancement", (status) => {
  const { runtime, pending, reply, formal } = setup(false);
  runtime.commit(formal);
  runtime.markDisconnected();
  const nextScope = { ...scope, channelId: "reconnected", leafId: "handshake-leaf" };
  runtime.prepareLive(nextScope, formal.event_seq!);
  runtime.commitReplacement();
  runtime.prependHistory([formal]);
  const query = runtime.requestDeliveryStatus(pending.clientRequestId)!;
  vi.mocked(Date.now).mockReturnValue(1_000 + DELIVERY_STATUS_QUERY_TIMEOUT_MS);
  runtime.expireDeliveryStatusQueries();
  const change = runtime.receive(reply({ ...positive(status), target_channel_id: nextScope.channelId, leaf_id: "older-reply-leaf" }, query.frame.id));
  expect(change.items).toHaveLength(1);
  expect(change.observed).toHaveLength(1);
  expect(runtime.pendingItems).toEqual([]);
});
