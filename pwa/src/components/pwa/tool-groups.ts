import { entryGroupId, type PresentationEntry, type ToolEntry } from "@/lib/pwa/timeline-presentation";
import { toolStatus, type ToolStatus, type ToolValue } from "./tool-presentation";

/**
 * 本次投影中在线新追加的工具：排在某条上一次投影已有的条目之后。首次加载、切换会话（没有共同条目）
 * 与向前补齐的历史（排在所有已有条目之前）都不算新追加。
 */
export function appendedTools(entries: readonly PresentationEntry[], previous: readonly PresentationEntry[]): string[] {
  const known = new Set(previous.map(entry => entry.key));
  const added: string[] = [];
  let afterKnown = false;
  for (const entry of entries) {
    if (known.has(entry.key)) afterKnown = true;
    else if (afterKnown && entry.kind === "tool") added.push(entry.key);
  }
  return added;
}

/** 一个工具段：`key` 由组内最早被观察到的工具派生，作为组的身份。 */
export type ToolSegment = { key: string; tools: ToolEntry[] };

/** 用户对工具组的展开选择；`order` 越大越新。 */
export type ToolExpansion = { expanded: boolean; order: number };

/** 离线时 partial 无法确认仍在执行，与工具行一致按状态未知处理。 */
export function effectiveToolStatus(value: ToolValue, live: boolean): ToolStatus {
  return "partial_id" in value && !live ? "unknown" : toolStatus(value);
}

/** 为首次出现的工具记录观察顺序；没有新工具时原样返回，便于调用方跳过状态更新。 */
export function observeTools(entries: readonly PresentationEntry[], previous: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  let next: Map<string, number> | null = null;
  for (const entry of entries) {
    if (entry.kind !== "tool" || previous.has(entry.key) || next?.has(entry.key)) continue;
    next ??= new Map(previous);
    next.set(entry.key, next.size);
  }
  return next ?? previous;
}

function segmentAnchor(tools: readonly ToolEntry[], observed: ReadonlyMap<string, number>): string {
  let anchor = tools[0]!;
  for (const tool of tools) {
    if ((observed.get(tool.key) ?? Infinity) < (observed.get(anchor.key) ?? Infinity)) anchor = tool;
  }
  return anchor.key;
}

/**
 * 同一轮中展示相邻的工具从第一条起组成一段，不论状态或条数；正文、思考、其他记录与未保存缺口断开。
 * 组身份取最早被观察到的工具：历史向前补齐的工具晚于实时工具被观察，不改变已有组的身份。
 */
export function toolSegments(entries: readonly PresentationEntry[], gapKeys: ReadonlySet<string>, observed: ReadonlyMap<string, number>): ToolSegment[] {
  const segments: ToolSegment[] = [];
  let run: ToolEntry[] = [];
  let runGroup: string | undefined;
  const flush = () => {
    if (run.length === 0) return;
    segments.push({ key: `tools:${segmentAnchor(run, observed)}`, tools: run });
    run = [];
  };
  for (const entry of entries) {
    const groupId = entryGroupId(entry);
    if (groupId !== runGroup || gapKeys.has(entry.key)) {
      flush();
      runGroup = groupId;
    }
    if (entry.kind === "tool") {
      run.push(entry);
      continue;
    }
    flush();
  }
  flush();
  return segments;
}

/** 后续同轮正文／思考或正式 run_end 才闭合工具批次；闭合不代表组内工具已全部结束。 */
export function toolBatchClosed(entries: readonly PresentationEntry[], segment: ToolSegment, runEnded: (groupId: string) => boolean): boolean {
  const last = segment.tools.at(-1);
  if (last === undefined) return false;
  const groupId = entryGroupId(last)!;
  if (runEnded(groupId)) return true;
  const lastIndex = entries.findIndex(entry => entry.key === last.key);
  if (lastIndex < 0) return false;
  const formal = entries.findLast(entry => !isPartialEntry(entry) && entryGroupId(entry) !== undefined);
  const turnGroup = formal === undefined ? undefined : entryGroupId(formal);
  return entries.slice(lastIndex + 1).some(entry =>
    (entry.kind === "text" || entry.kind === "thinking") && entryGroupId(entry) === groupId
    && (!entry.streaming || turnGroup === undefined || turnGroup === groupId),
  );
}

/** 组的有效选择取成员上最近一次的选择，重新分段后新段仍继承用户已做的选择。 */
export function segmentExpansion(tools: readonly ToolEntry[], choices: ReadonlyMap<string, ToolExpansion>): ToolExpansion | undefined {
  let latest: ToolExpansion | undefined;
  for (const tool of tools) {
    const choice = choices.get(tool.key);
    if (choice && (!latest || choice.order > latest.order)) latest = choice;
  }
  return latest;
}

/** 在组内全部成员上记录一次新的展开选择，顺序号大于已有选择；组之后被拆分时每一段都继承该选择。 */
export function withExpansion(choices: ReadonlyMap<string, ToolExpansion>, members: readonly string[], expanded: boolean): ReadonlyMap<string, ToolExpansion> {
  let order = 0;
  for (const choice of choices.values()) order = Math.max(order, choice.order + 1);
  const next = new Map(choices);
  for (const key of members) next.set(key, { expanded, order });
  return next;
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
