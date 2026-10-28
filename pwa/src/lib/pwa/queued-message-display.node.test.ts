import { expect, test } from "vitest";
import { TimelineRuntime, type TimelinePending, type TimelineScope, type TimelineViewItem } from "./timeline-runtime";
import type { ServerFrame } from "../pi-reach/protocol-v2/frames";
import { entersTimeline, isQueuedMessage, leftQueueIntoTimeline } from "./queued-message-display";
import { projectTimeline } from "./timeline-presentation";

const scope: TimelineScope = { deviceId: "d", endpointId: "e", runtimeInstanceId: "r", sessionId: "s", leafId: "g", selfSenderRef: "owner", channelId: "c" };
type QueueFrame = Extract<ServerFrame, { type: "queued_message_state" }>;
function snapshot(items: QueueFrame["items"], id = "snapshot"): QueueFrame {
  return { protocol_version: 2, type: "queued_message_state", session_id: "s", leaf_id: "g", snapshot_id: id, chunk_index: 0, final: true, items };
}
const queueItem = (editable: boolean): QueueFrame["items"][number] => ({ id: "q", text: "later", sender_ref: "owner", editable, created_at: 1 });
/** 运行时原位修改 pending；比较前后归属时按值复制当前视图。 */
const view = (runtime: TimelineRuntime): TimelineViewItem[] => runtime.pendingItems.map((pending) => ({ ...pending }));
const pendingOf = (items: readonly TimelineViewItem[]): TimelinePending => items.find((item): item is TimelinePending => item.kind === "pending")!;

function expectedRuntime() {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  runtime.sendUser("later", undefined, { clientRequestId: "q", requestId: "send" }, { queueExpected: true });
  return runtime;
}

test("sends while Pi works stay in the queue area from the first frame until they start", () => {
  const runtime = expectedRuntime();
  const sent = view(runtime);
  expect(pendingOf(sent)).toMatchObject({ delivery: "pending", queueExpected: true });
  expect(isQueuedMessage(pendingOf(sent))).toBe(true);
  // 权威快照确认排队：仍在排队区，不经过对话区。
  runtime.receive(snapshot([queueItem(true)]));
  const queued = view(runtime);
  expect(isQueuedMessage(pendingOf(queued))).toBe(true);
  expect(leftQueueIntoTimeline(sent, queued)).toBe(false);
  // 开始投递（editable=false）后离开排队区进入对话区。
  runtime.receive(snapshot([queueItem(false)], "next"));
  const started = view(runtime);
  expect(isQueuedMessage(pendingOf(started))).toBe(false);
  expect(leftQueueIntoTimeline(queued, started)).toBe(true);
  expect(entersTimeline(pendingOf(started))).toBe(true);
});

test("expected queueing ends on start, failure or unknown delivery without changing confirmation", () => {
  const ordinary = new TimelineRuntime();
  ordinary.setScope(scope);
  ordinary.sendUser("now", undefined, { clientRequestId: "n", requestId: "send-n" });
  expect(isQueuedMessage(pendingOf(view(ordinary)))).toBe(false);

  const failed = expectedRuntime();
  const before = view(failed);
  failed.markDeliveryFailed("q", "transport_unavailable", true);
  const after = view(failed);
  expect(isQueuedMessage(pendingOf(after))).toBe(false);
  // 失败回到对话区显示原因，不按出队播放进入过渡。
  expect(leftQueueIntoTimeline(before, after)).toBe(false);
  expect(entersTimeline(pendingOf(after))).toBe(false);

  const unknown = expectedRuntime();
  unknown.markUnknownDelivery("q");
  expect(isQueuedMessage(pendingOf(view(unknown)))).toBe(false);

  const started = expectedRuntime();
  const pending = started.pendingItems[0]!;
  expect(isQueuedMessage({ ...pending, messageId: "m" })).toBe(false);
  expect(isQueuedMessage({ ...pending, queueInFlight: true })).toBe(false);
});

test("a dequeued message enters the conversation with the send animation once", () => {
  const runtime = expectedRuntime();
  runtime.receive(snapshot([queueItem(true)]));
  const visible = (items: TimelineViewItem[]) => items.filter((item) => !isQueuedMessage(item));
  const before = projectTimeline(visible(view(runtime)));
  expect(before.entries).toHaveLength(0);
  runtime.receive(snapshot([queueItem(false)], "next"));
  const entered = projectTimeline(visible(view(runtime)), before);
  expect(entered.entries).toMatchObject([{ kind: "record", userMessageIn: true }]);
  // 初次投影（如刷新后恢复的在途项）不播放。
  expect(projectTimeline(visible(view(runtime))).entries[0]).not.toHaveProperty("userMessageIn");
});
