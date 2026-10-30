import { useEffect, useId, useState, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, CircleHelp, CircleStop, LoaderCircle } from "lucide-react";

import { toolHeaderSummary, toolIdentity, toolInlineText, toolStatus, type ToolStatus, type ToolValue } from "./tool-presentation";
import { useI18n } from "@/lib/i18n";
import { toolGroupSummary } from "./process-group-state";
export { toolGroupSummary } from "./process-group-state";
import { Collapse } from "./collapse";
import { effectiveToolStatus } from "./tool-groups";
import { GROUP_HEAD_MIN_VISIBLE_MS, GROUP_HEAD_QUEUED_VISIBLE_MS, groupHeadTool, initialGroupHead, stepGroupHead, type GroupHeadElapsed } from "./tool-group-head";
import { ToolIndicatorContext, useToolIndicatorRef, useVisibleToolIndicators, type RunningToolsChange } from "./tool-indicator-visibility";
import "./tool-reader.css";

type ToolCardProps = {
  value: ToolValue;
  onRead: (trigger: HTMLButtonElement) => void;
  status?: ToolStatus;
  timelineKey?: string;
  /** 过程组内的工具以成员 key 注册可见性；省略时沿用工具身份。 */
  indicatorKeys?: readonly string[];
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
export function ToolCard({ value, onRead, status: statusOverride, timelineKey, indicatorKeys }: ToolCardProps) {
  const { t } = useI18n();
  const status = toolStatus(value, statusOverride);
  const summary = toolInlineText(toolHeaderSummary(value));

  return <article className={`pwa-tool-card pwa-tool-card-${status} pwa-timeline-row`} data-tool-status={status} data-tool-key={toolIdentity(value)} data-viewport-row={timelineKey}>
    <div className="pwa-tool-head">
      <button className="pwa-tool-action pwa-timeline-toggle pwa-timeline-heading" type="button" aria-label={t.tools.viewDetails(value.tool)} aria-haspopup="dialog" onClick={event => onRead(event.currentTarget)}>
        <span className="pwa-tool-action-copy"><strong title={value.tool}>{value.tool}</strong>{summary ? <span title={summary}>{summary}</span> : null}</span>
        <span className={`pwa-tool-status pwa-tool-status-${status}`} role="status" aria-label={t.tools.statusLabel(value.tool, t.tools.status[status])}><ToolStatusIcon status={status} toolKeys={indicatorKeys ?? [toolIdentity(value)]} />{status === "complete" ? null : <span>{status === "unknown" ? t.timeline.unknown : t.tools.status[status]}</span>}</span>
      </button>
    </div>
  </article>;
}

/** 组头调用文字：每次换成新的工具时从下方进入一次，组头首次出现时不播放。 */
function ToolGroupCurrent({ value, animate }: { value: ToolValue; animate: boolean }) {
  const summary = toolInlineText(toolHeaderSummary(value));
  return <span className="pwa-tool-group-current" data-enter={animate ? "" : undefined}>
    <strong title={value.tool}>{value.tool}</strong>{summary ? <span title={summary}>{summary}</span> : null}
  </span>;
}

function ToolGroupSummary({ summary }: { summary: string }) {
  return <span className="pwa-tool-group-summary" title={summary}><span className="pwa-tool-group-summary-text">{summary}</span></span>;
}

const NOT_ELAPSED: GroupHeadElapsed = { queued: false, minimum: false };
const NO_APPENDED: ReadonlySet<string> = new Set();

/** 组头排队显示：按开始顺序逐条显示，计时从每条进入组头时开始，规则见 `stepGroupHead`。 */
function useGroupHeadTool(values: readonly ToolValue[], live: boolean, appended: ReadonlySet<string>, batchClosed: boolean): { value: ToolValue | null; animate: boolean } {
  const [state, setState] = useState(() => initialGroupHead(values, live, appended));
  const [elapsed, setElapsed] = useState({ index: state.index, ...NOT_ELAPSED });
  const timing = elapsed.index === state.index ? elapsed : NOT_ELAPSED;
  const next = stepGroupHead(state, values, live, timing, appended, batchClosed);
  if (next !== state) setState(next);
  useEffect(() => {
    const index = state.index;
    if (index < 0) return;
    const queued = window.setTimeout(() => setElapsed(current => ({ index, queued: true, minimum: current.index === index && current.minimum })), GROUP_HEAD_QUEUED_VISIBLE_MS);
    const minimum = window.setTimeout(() => setElapsed({ index, queued: true, minimum: true }), GROUP_HEAD_MIN_VISIBLE_MS);
    return () => { window.clearTimeout(queued); window.clearTimeout(minimum); };
  }, [state.index]);
  return { value: groupHeadTool(next, values, live), animate: next.animate };
}

/** 组头文字独立轮播；运行提示始终表达整组状态，首次渲染与 SSR 共用相同判断。 */
export function initialToolGroupRunningIndicators(values: readonly ToolValue[], live: boolean): readonly string[] {
  return values.filter(value => effectiveToolStatus(value, live) === "running").map(toolIdentity);
}

/**
 * 同一轮中相邻的工具从第一条起组成工具组。折叠时组头按开始顺序排队显示工具，每条至少停留一段时间，积压过多时跳到最新；
 * 批次闭合、全组工具结束且最后一条停满后回到分类摘要，同批不重播。展开时组头只显示摘要。含失败时显示错误图标，仅有中断时不显示。
 */
export function ToolGroupCard({ values, live, appended = NO_APPENDED, batchClosed = false, expanded, onExpandedChange, timelineKey, activityKey, onRunningToolsChange, children }: { values: readonly ToolValue[]; live: boolean; appended?: ReadonlySet<string>; batchClosed?: boolean; expanded: boolean; onExpandedChange: (expanded: boolean) => void; timelineKey?: string; activityKey?: string; onRunningToolsChange?: RunningToolsChange; children: ReactNode }) {
  const { t } = useI18n();
  const id = useId();
  const summary = toolGroupSummary(values, t.tools);
  const hasFailure = values.some(value => toolStatus(value) === "error");
  const head = useGroupHeadTool(values, live, appended, batchClosed);
  const current = expanded ? null : head.value;
  const currentStatus = current ? effectiveToolStatus(current, live) : null;
  const runningKeys = initialToolGroupRunningIndicators(values, live);
  const runningCount = runningKeys.length;
  // 收起与展开都由组头表达整组运行状态，调用文字和各子行保留自己的语义。
  const busy = runningCount > 0;
  const headStatus = busy ? "running" : currentStatus;
  const { groupRef, register, observe } = useVisibleToolIndicators(activityKey, onRunningToolsChange);
  const currentCommand = current ? `${current.tool} ${toolInlineText(toolHeaderSummary(current))}`.trim() : null;
  const currentLabel = currentCommand === null || currentStatus === null ? null
    : busy ? currentCommand : t.tools.statusLabel(currentCommand, t.tools.status[currentStatus]);
  const detailsId = `pwa-tool-group-${id.replace(/:/g, "")}`;
  return <ToolIndicatorContext value={register}><article ref={groupRef} className="pwa-tool-group pwa-timeline-row" data-tool-group-size={values.length} data-timeline-key={timelineKey} data-viewport-row={timelineKey}>
    <div className="pwa-tool-head">
      <button className="pwa-tool-action pwa-timeline-toggle pwa-timeline-heading" type="button" aria-label={t.tools.groupToggle(expanded, [currentLabel, busy ? t.tools.groupBusy(runningCount) : null, summary].filter(Boolean).join(" · "))} aria-expanded={expanded} aria-controls={detailsId} onClick={() => onExpandedChange(!expanded)}>
        <span className="pwa-tool-action-copy">{current
          ? <ToolGroupCurrent key={toolIdentity(current)} value={current} animate={head.animate} />
          : <ToolGroupSummary summary={summary} />}</span>
        {/* 状态槽和旋转图标不随轮播工具重建；同一个图标注册组内全部运行身份。 */}
        {headStatus ? <span className={`pwa-tool-group-status pwa-tool-status pwa-tool-status-${headStatus}`}><ToolStatusIcon status={headStatus} toolKeys={busy ? runningKeys : []} /></span> : null}
        {hasFailure && headStatus !== "error" ? <CircleAlert className="pwa-tool-group-alert" size={16} aria-hidden="true" /> : null}
        <ChevronRight className="pwa-tool-chevron pwa-timeline-chevron" size={16} aria-hidden="true" />
      </button>
    </div>
    <Collapse open={expanded} id={detailsId} className="pwa-tool-group-details" onPresentationChange={observe}>
      {children}
    </Collapse>
  </article></ToolIndicatorContext>;
}
