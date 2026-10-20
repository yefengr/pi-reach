import type { ServerFrame } from "@/lib/pi-reach/protocol-v2/frames";
import type { TimelineViewItem } from "./timeline-runtime";

export type OperationAction = "session_new" | "session_compact" | "model_set" | "thinking_set";
export const OPERATION_CONFIRMATION_TIMEOUT_MS = 30_000;
export type PendingSessionAction = {
  id: string;
  sessionId: string;
  action: OperationAction;
  phase: "pending" | "accepted" | "unknown";
  startedAt: number;
  requestedThinking?: string;
  targetSessionId?: string;
  readySessionId?: string;
  dataSessionId?: string;
  /** 仅 /new 交接期间保留当前可见投影，不作为其他会话的缓存。 */
  projection?: TimelineViewItem[];
};
export type PendingStop = { id: string; groupId: string; sessionId: string; leafId: string | null; startedAt: number; unknown: boolean; accepted?: boolean };
export type CompactionActivity = { sessionId: string; status: "running" | "completed" | "failed" | "cancelled" | "unknown" };
/** 本地、不持久化的时间线提示；afterSeq 为发生时的最后一条正式记录。 */
export type CompactionNotice = { id: string; sessionId: string; afterSeq: number; tone: "neutral" | "error"; text: string };

/** 输入区提示行：进行中的操作只由旋转图标表达，文字保持中性色。 */
export type OperationHint = { text: string; tone: "running" | "neutral"; busy: boolean };
type OperationHintMessages = {
  creatingSession: string; openingSession: string; compacting: string;
  compactCancelled: string; compactFailed: string; unknown: string;
  newUnknown: string; configUnknown: string; stopUnknown: string;
  requestingStop: string; stopAccepted: string;
};

/** 新建、停止与配置确认的提示；压缩由时间线负责，不在这里出现。 */
export function operationHint(pending: PendingSessionAction | null, stop: PendingStop | null, messages: OperationHintMessages): OperationHint | null {
  if (stop) return stop.unknown
    ? { text: messages.stopUnknown, tone: "neutral", busy: false }
    : { text: stop.accepted ? messages.stopAccepted : messages.requestingStop, tone: "running", busy: true };
  if (!pending) return null;
  if (pending.action === "session_new") return pending.phase === "unknown"
    ? { text: messages.newUnknown, tone: "neutral", busy: false }
    : { text: pending.targetSessionId ? messages.openingSession : messages.creatingSession, tone: "running", busy: true };
  if (pending.action === "session_compact") return pending.phase === "unknown"
    ? { text: messages.unknown, tone: "neutral", busy: false } : null;
  if ((pending.action === "model_set" || pending.action === "thinking_set") && pending.phase === "unknown") {
    return { text: messages.configUnknown, tone: "neutral", busy: false };
  }
  return null;
}

/** 压缩终态进入消息流，锚定在发生时的最后一条记录之后。 */
export function compactionTerminal(activity: CompactionActivity | null, messages: OperationHintMessages): { text: string; tone: "neutral" | "error" } | null {
  if (!activity) return null;
  if (activity.status === "failed") return { text: messages.compactFailed, tone: "error" };
  if (activity.status === "cancelled") return { text: messages.compactCancelled, tone: "neutral" };
  if (activity.status === "unknown") return { text: messages.unknown, tone: "neutral" };
  return null;
}

export function actionReply(pending: PendingSessionAction | null, frame: Extract<ServerFrame, { type: "action_ok" | "action_error" }>): PendingSessionAction | null {
  if (!pending || frame.in_reply_to !== pending.id || frame.action !== pending.action) return pending;
  if (frame.type === "action_error") return null;
  if (frame.action === "session_compact") return frame.phase === "accepted" ? { ...pending, phase: "accepted" } : null;
  if (frame.action !== "session_new") return null;
  const next = { ...pending, phase: "accepted" as const, targetSessionId: frame.session_id };
  return newSessionIsReady(next) ? null : next;
}

export function newSessionIsReady(pending: PendingSessionAction): boolean {
  return pending.action === "session_new" && pending.targetSessionId !== undefined
    && pending.readySessionId === pending.targetSessionId && pending.dataSessionId === pending.targetSessionId;
}

export function observeNewSession(pending: PendingSessionAction | null, sessionId: string, dataReady: boolean): PendingSessionAction | null {
  if (pending?.action !== "session_new") return pending;
  const next = { ...pending, readySessionId: sessionId, ...(dataReady ? { dataSessionId: sessionId } : {}) };
  return newSessionIsReady(next) ? null : next;
}

/** 停止只针对当前末轮；排队消息及已正式结束的轮次不能成为停止目标。 */
export function currentRunGroup(items: readonly TimelineViewItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "pending") continue;
    if (item.kind === "partial") return item.partial.group_id;
    if (!item.event.group_id) continue;
    return item.event.kind === "run_end" ? null : item.event.group_id;
  }
  return null;
}

export function stopHasEnded(stop: PendingStop, items: readonly TimelineViewItem[]): boolean {
  return items.some((item) => item.kind === "event" && item.event.kind === "run_end"
    && item.event.session_id === stop.sessionId && item.event.group_id === stop.groupId);
}
