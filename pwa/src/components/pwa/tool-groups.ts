import { entryGroupId, type PresentationEntry, type ToolEntry } from "@/lib/pwa/timeline-presentation";
import { toolStatus, type ToolStatus, type ToolValue } from "./tool-presentation";

/** 一个工具段：`anchor` 是组内最早被观察到的工具 key，`key` 由它派生，作为组的身份。 */
export type ToolSegment = { key: string; anchor: string; tools: ToolEntry[] };

/** 用户对工具组的展开选择；`order` 越大越新，`follow` 表示该次展开不暂停自动跟随。 */
export type ToolExpansion = { expanded: boolean; order: number; follow: boolean };

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
    const anchor = segmentAnchor(run, observed);
    segments.push({ key: `tools:${anchor}`, anchor, tools: run });
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

/** 组头显示的当前工具：只取最后开始的一条，它已结束时返回 null，较早仍在运行的工具不回到组头。 */
export function currentTool(values: readonly ToolValue[], live: boolean): ToolValue | null {
  const last = values.at(-1);
  return last !== undefined && effectiveToolStatus(last, live) === "running" ? last : null;
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

/** 在锚点工具上记录一次新的展开选择，顺序号大于已有选择。 */
export function withExpansion(choices: ReadonlyMap<string, ToolExpansion>, anchor: string, expanded: boolean, follow: boolean): ReadonlyMap<string, ToolExpansion> {
  let order = 0;
  for (const choice of choices.values()) order = Math.max(order, choice.order + 1);
  return new Map(choices).set(anchor, { expanded, order, follow: expanded && follow });
}

export type TimelineActivity = {
  /** 工具组是否为末段且仍在运行：位于时间线末尾，Pi 仍在本轮运行或组内仍有工具运行。 */
  liveTail: (segment: ToolSegment) => boolean;
  /** Working 提示：Pi working、末尾没有正在输出的内容，且最后一轮尚未收到 run_end。 */
  working: boolean;
};

/** 时间线末尾的运行情况；最后一轮已收到 run_end 时不算仍在运行，避免 working 晚于结束事件更新时闪现。 */
export function timelineActivity(entries: readonly PresentationEntry[], segments: readonly ToolSegment[], live: boolean, running: boolean, runEnded: (groupId: string) => boolean): TimelineActivity {
  const toolRunning = (tools: readonly ToolEntry[]) => tools.some(tool => effectiveToolStatus(tool.value, live) === "running");
  const last = entries.at(-1);
  const lastGroup = last === undefined ? undefined : entryGroupId(last);
  const runActive = live && running && !(lastGroup !== undefined && runEnded(lastGroup));
  const outputActive = segments.some(segment => toolRunning(segment.tools))
    || entries.some(entry => (entry.kind === "text" || entry.kind === "thinking") && entry.streaming);
  return {
    liveTail: segment => segment.tools.at(-1) === last && (runActive || toolRunning(segment.tools)),
    working: runActive && entries.length > 0 && !outputActive,
  };
}
