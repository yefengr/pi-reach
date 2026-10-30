import { getMessages, type Messages } from "@/lib/i18n";
import type { PresentationEntry } from "@/lib/pwa/timeline-presentation";
import type { RunCompletion } from "@/lib/pwa/run-completion";
import { processExpansion, type ProcessEntry, type ProcessExpansion, type ProcessGroup } from "./process-groups";
import { effectiveProcessStatus, type TimelineActivity } from "./timeline-activity";
import { toolAction, toolStatus, type ToolKind, type ToolStatus, type ToolValue } from "./tool-presentation";

export type ProcessStatus = ToolStatus | "neutral";
export type ProcessGroupState = {
  activeEntry: ProcessEntry | null;
  additionalRunningTools: number;
  entryStatuses: ReadonlyMap<string, ProcessStatus>;
  status: ProcessStatus;
  expanded: boolean;
  expansionSource: "manual" | "protected" | "completed" | "running" | "retained" | "history";
  canHostWorking: boolean;
};

type ProcessContext = {
  entries: readonly PresentationEntry[];
  activity: TimelineActivity;
  observed: ReadonlyMap<string, number>;
  completion?: RunCompletion;
  choices: ReadonlyMap<string, ProcessExpansion>;
  protectedReading?: boolean;
  previousExpanded?: boolean;
};

function expansionState(group: ProcessGroup, context: ProcessContext, running: boolean): Pick<ProcessGroupState, "expanded" | "expansionSource"> {
  const manual = processExpansion(group.entries, context.choices);
  if (manual !== undefined) return { expanded: manual.expanded, expansionSource: "manual" };
  if (context.protectedReading) return { expanded: true, expansionSource: "protected" };
  if (context.completion !== undefined) return { expanded: false, expansionSource: "completed" };
  if (running) return { expanded: true, expansionSource: "running" };
  if (context.previousExpanded !== undefined) return { expanded: context.previousExpanded, expansionSource: "retained" };
  return { expanded: false, expansionSource: "history" };
}

/** 组状态不反写成员：真实错误优先于中断，再保留未知；缺 run_end 不宣告全成功。 */
function settledStatus(group: ProcessGroup, statuses: ReadonlyMap<string, ProcessStatus>, completion?: RunCompletion): ProcessStatus {
  const values = new Set(statuses.values());
  if (values.has("error") || completion?.status === "error") return "error";
  if (values.has("interrupted") || completion?.status === "interrupted") return "interrupted";
  if (values.has("unknown")) return "unknown";
  const emptyTrace = group.entries.every(entry => entry.kind === "thinking" && !entry.streaming && !entry.text.trim());
  if (completion === undefined && !emptyTrace) return "unknown";
  return group.entries.some(entry => entry.kind === "tool") ? "complete" : "neutral";
}

export function processGroupState(group: ProcessGroup, context: ProcessContext): ProcessGroupState {
  const { entries, activity, observed, completion } = context;
  const entryStatuses = new Map<string, ProcessStatus>();
  let activeEntry: ProcessEntry | null = null;
  let activeOrder = -Infinity;
  let runningTools = 0;
  let lastObserved = -1;
  for (const order of observed.values()) lastObserved = Math.max(lastObserved, order);
  for (const [index, entry] of group.entries.entries()) {
    const status = effectiveProcessStatus(entry, entries, activity);
    entryStatuses.set(entry.key, status);
    if (status !== "running") continue;
    if (entry.kind === "tool") runningTools += 1;
    // 未进入观察表的成员等价于本次按稳定成员顺序首次观察，不读取时间戳。
    const order = observed.get(entry.key) ?? lastObserved + index + 1;
    if (order <= activeOrder) continue;
    activeEntry = entry;
    activeOrder = order;
  }
  const running = activity.working && group.entries.some(entry => activity.currentIndicator(entry));
  const last = entries.at(-1);
  const canHostWorking = running && last !== undefined && activity.currentIndicator(last)
    && group.entries.some(entry => entry.key === last.key);
  const active: ProcessEntry | null = activeEntry;
  return {
    activeEntry: active,
    additionalRunningTools: active === null ? 0 : runningTools - (active.kind === "tool" ? 1 : 0),
    entryStatuses,
    status: active !== null || running ? "running" : settledStatus(group, entryStatuses, completion),
    ...expansionState(group, context, running),
    canHostWorking,
  };
}

type SummaryTool = { value: ToolValue; status: ProcessStatus };

/** 两个入口共享一次分类与状态计数，Thinking 不参与工具次数。 */
function toolSummary(tools: readonly SummaryTool[], t: Messages["tools"]): { parts: string[]; failureCount: number; interruptedCount: number; unknownCount: number } {
  const order: ToolKind[] = [];
  const calls = new Map<ToolKind, number>();
  const paths = new Map<ToolKind, Set<string>>();
  let failureCount = 0;
  let interruptedCount = 0;
  let unknownCount = 0;
  for (const { value, status } of tools) {
    const action = toolAction(value);
    if (!calls.has(action.kind)) order.push(action.kind);
    calls.set(action.kind, (calls.get(action.kind) ?? 0) + 1);
    if (!paths.has(action.kind)) paths.set(action.kind, new Set());
    paths.get(action.kind)!.add(action.detail);
    if (status === "error") failureCount += 1;
    if (status === "interrupted") interruptedCount += 1;
    if (status === "unknown") unknownCount += 1;
  }
  const label = { read: t.groupRead, command: t.groupCommand, search: t.groupSearch, edit: t.groupEdit, write: t.groupWrite, generic: t.groupGeneric } satisfies Record<ToolKind, (count: number) => string>;
  const parts = order.map(kind => label[kind](kind === "read" || kind === "edit" || kind === "write" ? paths.get(kind)!.size : calls.get(kind)!));
  if (failureCount > 0) parts.push(t.groupFailed(failureCount));
  if (interruptedCount > 0) parts.push(t.groupInterrupted(interruptedCount));
  return { parts, failureCount, interruptedCount, unknownCount };
}

export function processGroupSummary(group: ProcessGroup, statuses: ReadonlyMap<string, ProcessStatus>, t: Messages["tools"]): { fullLabel: string; compactLabel: string; failureCount: number; interruptedCount: number; unknownCount: number } {
  const tools: SummaryTool[] = [];
  let unknownThinking = 0;
  for (const entry of group.entries) {
    if (entry.kind === "tool") tools.push({ value: entry.value, status: statuses.get(entry.key) ?? toolStatus(entry.value) });
    else if (statuses.get(entry.key) === "unknown") unknownThinking += 1;
  }
  const summary = toolSummary(tools, t);
  const unknownCount = summary.unknownCount + unknownThinking;
  const parts = tools.length > 0 ? summary.parts : [getMessages().timeline.thinkingTrace];
  if (unknownCount > 0) parts.push(t.statusLabel(String(unknownCount), t.status.unknown));
  const fullLabel = parts.join(" · ");
  return { fullLabel, compactLabel: fullLabel, failureCount: summary.failureCount, interruptedCount: summary.interruptedCount, unknownCount };
}
