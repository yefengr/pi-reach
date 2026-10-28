import type { TimelinePending, TimelineViewItem } from "./timeline-runtime";

/** 尚在投递流程中、可进入对话区的状态；失败、未知与取消由对话区或提示单独说明，不当作出队。 */
const DELIVERING = new Set<TimelinePending["delivery"]>(["pending", "received", "accepted", "committed"]);
/** 预计排队只在回执确认前后的正常投递状态内成立；失败或未知立即回到对话区显示原因。 */
const EXPECTED_QUEUE_DELIVERIES = new Set<TimelinePending["delivery"]>(["pending", "received", "accepted"]);

/**
 * 是否显示在输入区上方的排队区而不是对话区。只决定展示归属，不改变投递确认。
 * 插入提示是显式 notice，优先保留；在途项（editable===false）留在对话区，其余队列成员进等待区；
 * Pi 运行中发送的消息在队列快照到达前预计排队，直接显示在排队区。
 */
export function isQueuedMessage(item: TimelineViewItem): item is TimelinePending {
  if (item.kind !== "pending" || item.messageId !== undefined) return false;
  if (item.insertionStatus !== undefined) return true;
  if (item.queued === true) return item.queueInFlight !== true;
  return item.queueExpected === true && item.queueInFlight !== true && item.deliveryFailure === undefined && EXPECTED_QUEUE_DELIVERIES.has(item.delivery);
}

/** 发布时按值保存归属；Runtime 会原位更新 pending，不能把旧对象当成旧快照。 */
export function queuedMessageSnapshot(items: readonly TimelineViewItem[]): ReadonlySet<string> {
  return new Set(items.filter(isQueuedMessage).map((item) => item.id));
}

/** 本次显示变更中是否有排队消息离开排队区、作为正常投递中的消息进入对话区。 */
export function leftQueueIntoTimeline(queued: ReadonlySet<string>, next: readonly TimelineViewItem[]): boolean {
  if (queued.size === 0) return false;
  // 用布尔结果比较归属，避免类型守卫取反把同一 pending 收窄为 never。
  const inQueue: (item: TimelineViewItem) => boolean = isQueuedMessage;
  return next.some((item) => item.kind === "pending" && queued.has(item.id) && !inQueue(item) && DELIVERING.has(item.delivery));
}

/** 新进入对话区的本端消息是否播放进入动画：新发送或刚出队，失败、未知与取消的不播放。 */
export function entersTimeline(item: TimelinePending): boolean {
  return DELIVERING.has(item.delivery) && item.deliveryFailure === undefined
    && (item.queued !== true || item.queueInFlight === true || item.messageId !== undefined);
}
