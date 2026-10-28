import { useEffect, useRef } from "react";
import { QueuedMessages } from "./queued-messages";
import { useI18n } from "@/lib/i18n";
import type { PeerChannel } from "@/lib/pi-reach/peer-channel";
import { QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS, type TimelinePending, type TimelineRuntime, type TimelineRuntimeChange, type TimelineViewItem } from "@/lib/pwa/timeline-runtime";

export function isQueuedMessage(item: TimelineViewItem): item is TimelinePending {
  if (item.kind !== "pending" || item.messageId !== undefined) return false;
  // 插入提示是显式 notice，优先保留；在途项（editable===false）留在对话区，其余队列成员才进等待区。
  return item.insertionStatus !== undefined || (item.queued === true && item.queueInFlight !== true);
}

function nearestInsertionDeadline(items: TimelineViewItem[]): number | null {
  let deadline: number | null = null;
  for (const item of items) {
    if (item.kind !== "pending" || item.insertionStatus !== "waiting" || item.insertionRequestedAt === undefined) continue;
    const candidate = item.insertionRequestedAt + QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS;
    deadline = deadline === null ? candidate : Math.min(deadline, candidate);
  }
  return deadline;
}

type QueuedMessagesPanelProps = {
  items: TimelineViewItem[];
  isOnline: boolean;
  /** Pi 是否正在运行：插入要等本轮下一个边界才开始，运行期间不判定未确认。 */
  isWorking?: boolean;
  runtimeRef: { current: TimelineRuntime };
  channelRef: { current: PeerChannel | null };
  applyChange: (change: TimelineRuntimeChange) => void;
  onError: (message: string) => void;
};

export function QueuedMessagesPanel({ items, isOnline, isWorking = false, runtimeRef, channelRef, applyChange, onError }: QueuedMessagesPanelProps) {
  const q = useI18n().t.queued;
  const wasWorkingRef = useRef(isWorking);
  const runEndedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (isWorking) wasWorkingRef.current = true;
    else if (wasWorkingRef.current) {
      wasWorkingRef.current = false;
      runEndedAtRef.current = Date.now();
    }
  }, [isWorking]);
  useEffect(() => {
    if (isWorking) return;
    const requested = nearestInsertionDeadline(items);
    if (requested === null) return;
    // 运行结束后再给完整确认窗口：长回复可能超过固定时长，本轮结束时插入才会开始。
    const deadline = Math.max(requested, (runEndedAtRef.current ?? 0) + QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS);
    const now = Date.now();
    if (deadline <= now) {
      applyChange(runtimeRef.current.expireQueuedInsertions(now));
      return;
    }
    const timer = window.setTimeout(() => applyChange(runtimeRef.current.expireQueuedInsertions()), deadline - now);
    return () => window.clearTimeout(timer);
  }, [applyChange, isWorking, items, runtimeRef]);

  const act = (requestId: string, action: "insert" | "cancel") => {
    const runtime = runtimeRef.current;
    const channel = channelRef.current;
    if (!isOnline || !channel) return;
    const prepared = runtime.actOnQueued(requestId, action);
    if (!prepared) return;
    // Runtime 同步锁定，阻止同一次渲染内的连点；发送失败才释放。
    applyChange(prepared.change);
    if (channel.send(prepared.frame)) return;
    applyChange(runtime.releaseQueuedAction(prepared.frame.id));
    onError("Could not update the queued message. Check the connection and try again.");
  };
  return <QueuedMessages
    items={items.filter(isQueuedMessage).filter((item) => !item.insertionNoticeDismissed).map((item) => {
      const status = item.insertionStatus === "unconfirmed" ? q.unconfirmed
        : item.insertionStatus === "waiting" ? q.inserting
          : item.delivery === "unknown_delivery" ? q.waitingReconnect
            : item.queuedAction === "cancel" ? q.cancelling
              : item.cancelable ? q.queued : q.sending;
      return {
        id: item.clientRequestId,
        text: item.text,
        images: item.images,
        attachments: item.attachments,
        status,
        ...(status === q.queued ? { waiting: true } : {}),
        ...(status === q.inserting || status === q.cancelling || status === q.sending ? { pending: true } : {}),
        ...(item.insertionStatus === "unconfirmed" ? { notice: q.unconfirmedNotice, attention: true, dismissible: true } : {}),
        canManage: item.insertionStatus === undefined && item.cancelable === true && item.delivery !== "unknown_delivery",
        busy: item.queuedAction !== undefined || item.insertionStatus !== undefined,
      };
    })}
    isOnline={isOnline}
    onInsert={(requestId) => act(requestId, "insert")}
    onCancel={(requestId) => act(requestId, "cancel")}
    onDismissNotice={(requestId) => applyChange(runtimeRef.current.dismissQueuedInsertionNotice(requestId))}
  />;
}
