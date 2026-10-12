import { useEffect, useId, useState, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, CircleHelp, CircleStop, LoaderCircle } from "lucide-react";

import { toolAction, toolHeaderSummary, toolIdentity, toolInlineText, toolStatus, type ToolKind, type ToolStatus, type ToolValue } from "./tool-presentation";
import { useI18n, type Messages } from "@/lib/i18n";
import { Collapse } from "./collapse";
import { effectiveToolStatus } from "./tool-groups";
import { GROUP_HEAD_MIN_VISIBLE_MS, GROUP_HEAD_QUEUED_VISIBLE_MS, groupHeadTool, initialGroupHead, stepGroupHead, type GroupHeadElapsed } from "./tool-group-head";
import { ToolIndicatorContext, useToolIndicatorRef, useVisibleToolIndicators, type RunningToolsChange } from "./tool-indicator-visibility";
import "./tool-reader.css";

type ToolCardProps = {
  value: ToolValue;
  onRead: (trigger: HTMLButtonElement) => void;
  status?: ToolStatus;
};

function ToolStatusIcon({ status, toolKeys }: { status: ToolStatus; toolKeys: readonly string[] }) {
  const indicatorRef = useToolIndicatorRef(toolKeys);
  if (status === "running") return <LoaderCircle ref={indicatorRef} className="pwa-tool-spinner" size={16} aria-hidden="true" />;
  if (status === "complete") return <Check size={16} aria-hidden="true" />;
  if (status === "error") return <CircleAlert size={16} aria-hidden="true" />;
  if (status === "interrupted") return <CircleStop size={16} aria-hidden="true" />;
  return <CircleHelp size={16} aria-hidden="true" />;
}

/** 完成的工具只显示对勾，运行中、失败、中断与未知状态保留文字；各状态的可访问名称不变。 */
export function ToolCard({ value, onRead, status: statusOverride }: ToolCardProps) {
  const { t } = useI18n();
  const status = toolStatus(value, statusOverride);
  const summary = toolInlineText(toolHeaderSummary(value));

  return <article className={`pwa-tool-card pwa-tool-card-${status} pwa-timeline-row`} data-tool-status={status} data-tool-key={JSON.stringify([value.session_id, value.leaf_id, value.group_id, value.tool_call_id])}>
    <div className="pwa-tool-head">
      <button className="pwa-tool-action pwa-timeline-toggle pwa-timeline-heading" type="button" aria-label={t.tools.viewDetails(value.tool)} aria-haspopup="dialog" onClick={event => onRead(event.currentTarget)}>
        <span className="pwa-tool-action-copy"><strong title={value.tool}>{value.tool}</strong>{summary ? <span title={summary}>{summary}</span> : null}</span>
        <span className={`pwa-tool-status pwa-tool-status-${status}`} role="status" aria-label={t.tools.statusLabel(value.tool, t.tools.status[status])}><ToolStatusIcon status={status} toolKeys={[toolIdentity(value)]} />{status === "complete" ? null : <span>{status === "unknown" ? t.timeline.unknown : t.tools.status[status]}</span>}</span>
      </button>
    </div>
  </article>;
}

/** 连续工具的摘要：按类别计数、按首次出现排序；读取、修改、写入按不同路径计数；有失败或中断时末尾分别追加失败数与中断数。 */
export function toolGroupSummary(values: readonly ToolValue[], t: Messages["tools"]): string {
  const order: ToolKind[] = [];
  const calls = new Map<ToolKind, number>();
  const paths = new Map<ToolKind, Set<string>>();
  for (const value of values) {
    const action = toolAction(value);
    if (!calls.has(action.kind)) order.push(action.kind);
    calls.set(action.kind, (calls.get(action.kind) ?? 0) + 1);
    if (!paths.has(action.kind)) paths.set(action.kind, new Set());
    paths.get(action.kind)!.add(action.detail);
  }
  const label = { read: t.groupRead, command: t.groupCommand, search: t.groupSearch, edit: t.groupEdit, write: t.groupWrite, generic: t.groupGeneric } satisfies Record<ToolKind, (count: number) => string>;
  const failed = values.filter(value => toolStatus(value) === "error").length;
  const interrupted = values.filter(value => toolStatus(value) === "interrupted").length;
  const parts = order.map((kind) => label[kind](kind === "read" || kind === "edit" || kind === "write" ? paths.get(kind)!.size : calls.get(kind)!));
  if (failed > 0) parts.push(t.groupFailed(failed));
  if (interrupted > 0) parts.push(t.groupInterrupted(interrupted));
  return parts.join(" · ");
}

/** 组头工具：每次换成新的工具时从下方进入一次，组头首次出现时不播放；停留中的已结束工具显示其结束状态图标。 */
function ToolGroupCurrent({ value, status, animate }: { value: ToolValue; status: ToolStatus; animate: boolean }) {
  const summary = toolInlineText(toolHeaderSummary(value));
  return <span className="pwa-tool-group-current" data-enter={animate ? "" : undefined}>
    <span className={`pwa-tool-status pwa-tool-status-${status}`}><ToolStatusIcon status={status} toolKeys={[toolIdentity(value)]} /></span>
    <strong title={value.tool}>{value.tool}</strong>{summary ? <span title={summary}>{summary}</span> : null}
  </span>;
}

function ToolGroupSummary({ summary, runningKeys, busy }: { summary: string; runningKeys: readonly string[]; busy: boolean }) {
  const indicatorRef = useToolIndicatorRef(runningKeys);
  return <span className="pwa-tool-group-summary" title={summary}>{busy ? <LoaderCircle ref={indicatorRef} className="pwa-spin" size={16} aria-hidden="true" /> : null}<span className="pwa-tool-group-summary-text">{summary}</span></span>;
}

const NOT_ELAPSED: GroupHeadElapsed = { queued: false, minimum: false };
const NO_APPENDED: ReadonlySet<string> = new Set();

/** 组头排队显示：按开始顺序逐条显示，计时从每条进入组头时开始，规则见 `stepGroupHead`。 */
function useGroupHeadTool(values: readonly ToolValue[], live: boolean, appended: ReadonlySet<string>): { value: ToolValue | null; animate: boolean } {
  const [state, setState] = useState(() => initialGroupHead(values, live, appended));
  const [elapsed, setElapsed] = useState({ index: state.index, ...NOT_ELAPSED });
  const timing = elapsed.index === state.index ? elapsed : NOT_ELAPSED;
  const next = stepGroupHead(state, values, live, timing, appended);
  if (next !== state) setState(next);
  useEffect(() => {
    const index = state.index;
    if (index < 0) return;
    const queued = window.setTimeout(() => setElapsed(current => ({ index, queued: true, minimum: current.index === index && current.minimum })), GROUP_HEAD_QUEUED_VISIBLE_MS);
    const minimum = window.setTimeout(() => setElapsed({ index, queued: true, minimum: true }), GROUP_HEAD_MIN_VISIBLE_MS);
    return () => { window.clearTimeout(queued); window.clearTimeout(minimum); };
  }, [state.index]);
  return { value: groupHeadTool(next, values, live, next.index === state.index ? timing : NOT_ELAPSED), animate: next.animate };
}

/** 与实际渲染共用判断：已结束工具停留在收起组头时，其他运行工具尚不可见。 */
function toolGroupRunningIndicators(values: readonly ToolValue[], live: boolean, expanded: boolean, current: ToolValue | null): readonly string[] {
  if (expanded || current === null) return values.filter(value => effectiveToolStatus(value, live) === "running").map(toolIdentity);
  return effectiveToolStatus(current, live) === "running" ? [toolIdentity(current)] : [];
}

/** 首次渲染与 SSR 尚无组头报告时，沿用队列的初始状态，不猜测 runningCount。 */
export function initialToolGroupRunningIndicators(values: readonly ToolValue[], live: boolean, appended: ReadonlySet<string>, expanded: boolean): readonly string[] {
  const state = initialGroupHead(values, live, appended);
  const current = expanded ? null : groupHeadTool(state, values, live, NOT_ELAPSED);
  return toolGroupRunningIndicators(values, live, expanded, current);
}

/**
 * 同一轮中相邻的工具从第一条起组成工具组。折叠时组头按开始顺序排队显示工具，每条至少停留一段时间，积压过多时跳到最新；
 * 最后一条结束并停满后回到分类摘要，组内仍有工具运行时摘要前保留旋转图标。展开时组头只显示摘要。含失败时显示错误图标，仅有中断时不显示。
 */
export function ToolGroupCard({ values, live, appended = NO_APPENDED, expanded, onExpandedChange, timelineKey, activityKey, onRunningToolsChange, children }: { values: readonly ToolValue[]; live: boolean; appended?: ReadonlySet<string>; expanded: boolean; onExpandedChange: (expanded: boolean) => void; timelineKey?: string; activityKey?: string; onRunningToolsChange?: RunningToolsChange; children: ReactNode }) {
  const { t } = useI18n();
  const id = useId();
  const summary = toolGroupSummary(values, t.tools);
  const hasFailure = values.some(value => toolStatus(value) === "error");
  const head = useGroupHeadTool(values, live, appended);
  const current = expanded ? null : head.value;
  const currentStatus = current ? effectiveToolStatus(current, live) : null;
  const runningCount = values.filter(value => effectiveToolStatus(value, live) === "running").length;
  // 摘要态旋转图标对读屏隐藏，收起时工具行也未挂载，可访问名称里保留仍在运行的数量。
  const busy = current === null && !expanded && runningCount > 0;
  const { groupRef, register, observe } = useVisibleToolIndicators(activityKey, onRunningToolsChange);
  // 停留中的已结束工具也保留在可访问名称里，与屏幕上显示的工具和结束状态一致。
  const currentCommand = current ? `${current.tool} ${toolInlineText(toolHeaderSummary(current))}`.trim() : null;
  const currentLabel = currentCommand === null || currentStatus === null ? null
    : currentStatus === "running" ? t.tools.groupRunning(currentCommand) : t.tools.statusLabel(currentCommand, t.tools.status[currentStatus]);
  const detailsId = `pwa-tool-group-${id.replace(/:/g, "")}`;
  return <ToolIndicatorContext value={register}><article ref={groupRef} className="pwa-tool-group pwa-timeline-row" data-tool-group-size={values.length} data-timeline-key={timelineKey}>
    <div className="pwa-tool-head">
      <button className="pwa-tool-action pwa-timeline-toggle pwa-timeline-heading" type="button" aria-label={t.tools.groupToggle(expanded, [currentLabel, busy ? t.tools.groupBusy(runningCount) : null, summary].filter(Boolean).join(" · "))} aria-expanded={expanded} aria-controls={detailsId} onClick={() => onExpandedChange(!expanded)}>
        <span className="pwa-tool-action-copy">{current
          ? <ToolGroupCurrent key={toolIdentity(current)} value={current} status={currentStatus!} animate={head.animate} />
          : <ToolGroupSummary summary={summary} runningKeys={values.filter(value => effectiveToolStatus(value, live) === "running").map(toolIdentity)} busy={busy} />}</span>
        {hasFailure ? <CircleAlert className="pwa-tool-group-alert" size={16} aria-hidden="true" /> : null}
        <ChevronRight className="pwa-tool-chevron pwa-timeline-chevron" size={16} aria-hidden="true" />
      </button>
    </div>
    <Collapse open={expanded} id={detailsId} className="pwa-tool-group-details" onPresentationChange={observe}>
      {children}
    </Collapse>
  </article></ToolIndicatorContext>;
}
