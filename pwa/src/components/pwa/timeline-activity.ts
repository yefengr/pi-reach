import { entryGroupId, isPiOutputEntry, type PresentationEntry } from "@/lib/pwa/timeline-presentation";
import type { ProcessEntry } from "./process-groups";
import { toolStatus, type ToolStatus, type ToolValue } from "./tool-presentation";

/** 离线时 partial 无法确认仍在执行，与工具行一致按状态未知处理。 */
export function effectiveToolStatus(value: ToolValue, live: boolean): ToolStatus {
  return "partial_id" in value && !live ? "unknown" : toolStatus(value);
}

export type TimelineActivity = {
  /** 通用 Working 的运行边界；实际展示还要让位于本轮可见的具体运行指示。 */
  working: boolean;
  /** 本轮正在输出的条目，排除已结束、旧轮与空闲期间留下的 partial。 */
  currentOutput: (entry: PresentationEntry) => boolean;
  /** 可见图标属于当前运行的轮；退出冻结期间即使工具已完成，图标仍可暂时可见。 */
  currentIndicator: (entry: PresentationEntry) => boolean;
};

export function isPartialEntry(entry: PresentationEntry): boolean {
  if (entry.kind === "tool") return "partial_id" in entry.value;
  if (entry.kind === "text" || entry.kind === "thinking") return entry.streaming;
  return entry.item.kind === "partial";
}

/**
 * 时间线末尾的运行情况，只按末轮派生。运行时把 partial 排在正式事件之后，未与正式消息对上的旧 partial 会一直留在末尾；
 * 已收到 run_end 或不属于末轮（最后一条正式记录所属的轮）的 partial 视为残留，不算正在输出。
 * 末尾是新发送、尚未回传也未进入 Pi 队列的消息时，Pi 空闲期间就已存在的 partial（`idlePartials`）同样视为残留；
 * Pi 正在输出时发送的消息不触发该规则，避免将当前输出误判为残留。
 * 轮次的结束按末轮判断：末尾是新发送的消息时视为新的一轮；末尾是已进入 Pi 队列的消息时仍属当前轮。
 * 末轮已收到 run_end 时不算仍在运行，避免 working 晚于结束事件更新时闪现。
 */
export function timelineActivity(entries: readonly PresentationEntry[], live: boolean, running: boolean, runEnded: (groupId: string) => boolean, idlePartials: ReadonlySet<string> = new Set()): TimelineActivity {
  const formal = entries.findLast(entry => !isPartialEntry(entry) && entryGroupId(entry) !== undefined);
  const turnGroup = formal === undefined ? undefined : entryGroupId(formal);
  const settled = entries.findLast(entry => !isPartialEntry(entry));
  const freshSend = settled?.kind === "record" && settled.item.kind === "pending" && settled.item.queued !== true;
  const residual = (entry: PresentationEntry) => {
    const groupId = entryGroupId(entry);
    if (!isPartialEntry(entry) || groupId === undefined) return false;
    return runEnded(groupId) || (turnGroup !== undefined && groupId !== turnGroup) || (freshSend && idlePartials.has(entry.key));
  };
  const current = entries.filter(entry => !residual(entry));
  const turn = freshSend ? undefined : turnGroup;
  const runActive = live && running && !(turn !== undefined && runEnded(turn));
  const outputting = (entry: PresentationEntry) => entry.kind === "tool"
    ? effectiveToolStatus(entry.value, live) === "running"
    : (entry.kind === "text" || entry.kind === "thinking") && entry.streaming;
  return {
    working: runActive && current.length > 0,
    currentOutput: entry => runActive && !residual(entry) && outputting(entry),
    currentIndicator: entry => {
      const groupId = entryGroupId(entry);
      return runActive && groupId !== undefined && !runEnded(groupId)
        && (turnGroup === undefined || groupId === turnGroup)
        && !(freshSend && idlePartials.has(entry.key));
    },
  };
}

/** 记录首次观察而非更新时间；历史前插和输出增量不会改变已观察成员的次序。 */
export function observeProcessEntries(entries: readonly PresentationEntry[], previous: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  let next: Map<string, number> | undefined;
  let order = -1;
  for (const entry of entries) {
    if ((entry.kind !== "thinking" && entry.kind !== "tool") || previous.has(entry.key) || next?.has(entry.key)) continue;
    if (next === undefined) {
      next = new Map(previous);
      for (const observed of previous.values()) order = Math.max(order, observed);
    }
    next.set(entry.key, ++order);
  }
  return next ?? previous;
}

/** 新组专用：Thinking 缓冲尾巴不重亮，但后续输出不会结束并行工具。 */
export function effectiveProcessStatus(entry: ProcessEntry, entries: readonly PresentationEntry[], activity: TimelineActivity): ToolStatus | "neutral" {
  if (entry.kind === "tool") {
    if (!("partial_id" in entry.value)) return toolStatus(entry.value);
    return activity.currentOutput(entry) ? "running" : "unknown";
  }
  if (!entry.streaming) return "neutral";
  if (!activity.currentOutput(entry)) return "unknown";
  const index = entries.findIndex(candidate => candidate.key === entry.key);
  if (index < 0) return "unknown";
  const superseded = entries.slice(index + 1).some(candidate =>
    entryGroupId(candidate) === entry.groupId && isPiOutputEntry(candidate),
  );
  // 同一条流式消息里，思考块要到整条消息结束才转正式；同轮已有后续输出即说明思考已结束，按中性显示，不计入未知。
  return superseded ? "neutral" : "running";
}
