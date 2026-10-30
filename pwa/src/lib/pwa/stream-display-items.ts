import type { TimelineEvent, TimelinePartial } from "../pi-reach/protocol-v2/schema";
import type { TimelinePending, TimelineViewItem } from "./timeline-runtime";

/** 显示快照的条目比较：区分需要立即提交的状态变化与可按节奏合并的正文增长。 */

export type NonStreamToken =
  | { kind: "event"; id: string; event: TimelineEvent }
  | {
    kind: "pending";
    id: string;
    clientRequestId: string;
    text: string;
    images: TimelinePending["images"];
    createdAt: number;
    delivery: TimelinePending["delivery"];
    deliveryFailure: TimelinePending["deliveryFailure"];
    statusQuery: TimelinePending["statusQuery"];
    statusQueryUnsupported: TimelinePending["statusQueryUnsupported"];
    lastEvidenceAt: TimelinePending["lastEvidenceAt"];
    cancelable: boolean | undefined;
    queued: boolean | undefined;
    queueInFlight: boolean | undefined;
    queuedAction: TimelinePending["queuedAction"];
    queuedActionRequestId: string | undefined;
    insertionStatus: TimelinePending["insertionStatus"];
    insertionRequestedAt: number | undefined;
    insertionNoticeDismissed: boolean | undefined;
    messageId: string | undefined;
  };

export function partialText(partial: TimelinePartial): string {
  if (partial.blocks !== undefined) return partial.blocks.map((block) => block.text).join("\n");
  return partial.delta ?? "";
}

export function itemId(item: TimelineViewItem): string {
  if (item.kind === "event") return item.event.event_id;
  if (item.kind === "partial") return item.partial.partial_id;
  return item.clientRequestId;
}

type DeliveryMetadata = Pick<TimelinePending, "deliveryFailure" | "statusQuery" | "statusQueryUnsupported" | "lastEvidenceAt">;
function sameDeliveryMetadata(a: DeliveryMetadata, b: DeliveryMetadata): boolean {
  return a.deliveryFailure?.code === b.deliveryFailure?.code
    && a.deliveryFailure?.retryable === b.deliveryFailure?.retryable
    && a.statusQuery?.requestId === b.statusQuery?.requestId
    && a.statusQuery?.requestedAt === b.statusQuery?.requestedAt
    && a.statusQueryUnsupported === b.statusQueryUnsupported
    && a.lastEvidenceAt === b.lastEvidenceAt;
}

function sameItem(a: TimelineViewItem, b: TimelineViewItem): boolean {
  if (a.kind !== b.kind || itemId(a) !== itemId(b)) return false;
  if (a.kind === "event" && b.kind === "event") return a.event === b.event;
  if (a.kind === "pending" && b.kind === "pending") {
    return a.delivery === b.delivery
      && sameDeliveryMetadata(a, b)
      && a.text === b.text
      && a.createdAt === b.createdAt
      && a.messageId === b.messageId
      && a.cancelable === b.cancelable
      && a.queued === b.queued
      && a.queueInFlight === b.queueInFlight
      && a.queuedAction === b.queuedAction
      && a.queuedActionRequestId === b.queuedActionRequestId
      && a.insertionStatus === b.insertionStatus
      && a.insertionRequestedAt === b.insertionRequestedAt
      && a.insertionNoticeDismissed === b.insertionNoticeDismissed
      && a.images === b.images;
  }
  if (a.kind === "partial" && b.kind === "partial") return partialText(a.partial) === partialText(b.partial);
  return false;
}

export function sameItems(a: readonly TimelineViewItem[], b: readonly TimelineViewItem[]): boolean {
  return a.length === b.length && a.every((item, index) => sameItem(item, b[index]));
}

export function nonStreamTokens(items: readonly TimelineViewItem[]): NonStreamToken[] {
  const tokens: NonStreamToken[] = [];
  for (const item of items) {
    if (item.kind === "event") {
      tokens.push({ kind: "event", id: item.event.event_id, event: item.event });
      continue;
    }
    if (item.kind === "pending") {
      tokens.push({
        kind: "pending",
        id: item.id,
        clientRequestId: item.clientRequestId,
        text: item.text,
        images: item.images,
        createdAt: item.createdAt,
        delivery: item.delivery,
        // runtime 原位修改 pending；嵌套字段须按值捕获，不能持有可变引用。
        deliveryFailure: item.deliveryFailure ? { ...item.deliveryFailure } : undefined,
        statusQuery: item.statusQuery ? { ...item.statusQuery } : undefined,
        statusQueryUnsupported: item.statusQueryUnsupported,
        lastEvidenceAt: item.lastEvidenceAt,
        cancelable: item.cancelable,
        queued: item.queued,
        queueInFlight: item.queueInFlight,
        queuedAction: item.queuedAction,
        queuedActionRequestId: item.queuedActionRequestId,
        insertionStatus: item.insertionStatus,
        insertionRequestedAt: item.insertionRequestedAt,
        insertionNoticeDismissed: item.insertionNoticeDismissed,
        messageId: item.messageId,
      });
    }
  }
  return tokens;
}

export function sameNonStreamTokens(a: readonly NonStreamToken[], b: readonly NonStreamToken[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((token, index) => {
    const next = b[index];
    if (token.kind !== next.kind || token.id !== next.id) return false;
    if (token.kind === "event" && next.kind === "event") return token.event === next.event;
    if (token.kind === "pending" && next.kind === "pending") {
      return token.clientRequestId === next.clientRequestId
        && token.text === next.text
        && token.images === next.images
        && token.createdAt === next.createdAt
        && token.delivery === next.delivery
        && sameDeliveryMetadata(token, next)
        && token.cancelable === next.cancelable
        && token.queued === next.queued
        && token.queueInFlight === next.queueInFlight
        && token.queuedAction === next.queuedAction
        && token.queuedActionRequestId === next.queuedActionRequestId
        && token.insertionStatus === next.insertionStatus
        && token.insertionRequestedAt === next.insertionRequestedAt
        && token.insertionNoticeDismissed === next.insertionNoticeDismissed
        && token.messageId === next.messageId;
    }
    return false;
  });
}
