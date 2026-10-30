import { entryGroupId, type PresentationEntry, type ToolEntry } from "@/lib/pwa/timeline-presentation";
import { isPartialEntry } from "./timeline-activity";
export { effectiveToolStatus, isPartialEntry, timelineActivity, type TimelineActivity } from "./timeline-activity";

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
