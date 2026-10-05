import { useEffect } from "react";
import { QueuedMessages } from "./queued-messages";
import { useI18n } from "@/lib/i18n";
import type { PeerChannel } from "@/lib/pi-reach/peer-channel";
import { QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS, type TimelinePending, type TimelineRuntime, type TimelineRuntimeChange, type TimelineViewItem } from "@/lib/pwa/timeline-runtime";

export function isQueuedMessage(item: TimelineViewItem): item is TimelinePending {
  return item.kind === "pending" && item.messageId === undefined && (item.queued === true || item.insertionStatus !== undefined);
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
  runtimeRef: { current: TimelineRuntime };
  channelRef: { current: PeerChannel | null };
  applyChange: (change: TimelineRuntimeChange) => void;
  onError: (message: string) => void;
};

export function QueuedMessagesPanel({ items, isOnline, runtimeRef, channelRef, applyChange, onError }: QueuedMessagesPanelProps) {
  const q = useI18n().t.queued;
  useEffect(() => {
    const deadline = nearestInsertionDeadline(items);
    if (deadline === null) return;
    const now = Date.now();
    if (deadline <= now) {
      applyChange(runtimeRef.current.expireQueuedInsertions(now));
      return;
    }
    const timer = window.setTimeout(() => applyChange(runtimeRef.current.expireQueuedInsertions()), deadline - now);
    return () => window.clearTimeout(timer);
  }, [applyChange, items, runtimeRef]);

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
    items={items.filter(isQueuedMessage).filter((item) => !item.insertionNoticeDismissed).map((item) => ({
      id: item.clientRequestId,
      text: item.text,
      images: item.images,
      attachments: item.attachments,
      status: item.insertionStatus === "unconfirmed" ? q.unconfirmed
        : item.insertionStatus === "waiting" ? item.queuedAction === "insert" ? q.requestingInsert : q.awaitingInsert
          : item.delivery === "unknown_delivery" ? q.waitingReconnect
            : item.queuedAction === "cancel" ? q.cancelling
              : item.cancelable ? q.queued : q.sending,
      ...(item.insertionStatus === "unconfirmed" ? { notice: q.unconfirmedNotice, attention: true, dismissible: true } : {}),
      canManage: item.insertionStatus === undefined && item.cancelable === true && item.delivery !== "unknown_delivery",
      busy: item.queuedAction !== undefined || item.insertionStatus !== undefined,
    }))}
    isOnline={isOnline}
    onInsert={(requestId) => act(requestId, "insert")}
    onCancel={(requestId) => act(requestId, "cancel")}
    onDismissNotice={(requestId) => applyChange(runtimeRef.current.dismissQueuedInsertionNotice(requestId))}
  />;
}
