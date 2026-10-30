import { useCallback, useEffect, useId, useLayoutEffect, useRef, type FocusEvent, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, CircleHelp, CircleStop, Lightbulb, LoaderCircle } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { Collapse } from "./collapse";
import { processGroupSummary, type ProcessGroupState, type ProcessStatus } from "./process-group-state";
import type { ProcessEntry, ProcessGroup as ProcessGroupModel } from "./process-groups";
import { ThinkingProcessHeading, ThinkingProcessRow } from "./thinking-process-row";
import { ToolCard } from "./tool-card";
import { ToolIndicatorContext, useToolIndicatorRef, useVisibleToolIndicators, type RunningToolsChange } from "./tool-indicator-visibility";
import { toolHeaderSummary, toolInlineText, type ToolStatus } from "./tool-presentation";
import "./process-group.css";

export type { ProcessGroupModel };

const NO_KEYS: readonly string[] = [];

type ProcessGroupSummary = ReturnType<typeof processGroupSummary>;

type ProcessGroupProps = {
  group: ProcessGroupModel;
  state: ProcessGroupState;
  showWorking?: boolean;
  onToggle: (groupKey: string, expanded: boolean) => void;
  onRead: (entry: ProcessEntry, trigger: HTMLButtonElement) => void;
  onFocusWithinChange?: (groupKey: string, focused: boolean) => void;
  onRunningToolsChange?: RunningToolsChange;
  onPresentationChange?: () => void;
};

type IconRef = (node: SVGSVGElement | null) => void;

/** 状态槽只表达真实状态；Thinking 用 Lightbulb，工具与 Waiting 用旋转图标。 */
function ProcessStatusIcon({ status, thinking, iconRef }: { status: ProcessStatus; thinking: boolean; iconRef: IconRef }) {
  if (status === "running") {
    return thinking
      ? <Lightbulb ref={iconRef} size={16} aria-hidden="true" />
      : <LoaderCircle ref={iconRef} className="pwa-spin" size={16} aria-hidden="true" />;
  }
  if (status === "complete") return <Check ref={iconRef} size={16} aria-hidden="true" />;
  if (status === "error") return <CircleAlert ref={iconRef} size={16} aria-hidden="true" />;
  if (status === "interrupted") return <CircleStop ref={iconRef} size={16} aria-hidden="true" />;
  if (status === "neutral") return <Lightbulb ref={iconRef} size={16} aria-hidden="true" />;
  return <CircleHelp ref={iconRef} size={16} aria-hidden="true" />;
}

type ProcessGroupHeadProps = {
  group: ProcessGroupModel;
  state: ProcessGroupState;
  showWorking: boolean;
  summary: ProcessGroupSummary;
  detailsId: string;
  onToggle: (groupKey: string, expanded: boolean) => void;
};

/**
 * 组头只渲染推导好的内容：折叠时显示当前成员，展开时显示分类摘要；
 * 运行身份来自真实成员，不新增排队计时或调用轮播。
 */
function ProcessGroupHead({ group, state, showWorking, summary, detailsId, onToggle }: ProcessGroupHeadProps) {
  const { t } = useI18n();
  const active = state.activeEntry;
  const activeStatus: ProcessStatus | null = active === null ? null : state.entryStatuses.get(active.key) ?? "neutral";
  const runningKeys = state.expanded
    ? group.entries.filter(entry => state.entryStatuses.get(entry.key) === "running").map(entry => entry.key)
    : active !== null && activeStatus === "running" ? [active.key] : NO_KEYS;
  // 没有具体成员、也不承载通用 Working 时保持中性，避免给正文前的旧组挂运行状态。
  const iconStatus: ProcessStatus = state.status === "running" && active === null && !showWorking ? "neutral" : state.status;
  const indicatorRef = useToolIndicatorRef(runningKeys);
  const thinking = active?.kind === "thinking" && activeStatus === "running";
  const activeTool = active?.kind === "tool" ? active : null;
  const toolDetail = activeTool === null ? "" : toolInlineText(toolHeaderSummary(activeTool.value));
  const summaryAlert = summary.failureCount > 0 ? "error" : summary.unknownCount > 0 ? "unknown" : summary.interruptedCount > 0 ? "interrupted" : null;
  // 左侧状态槽已表达同一状态时不再重复右侧图标；数量仍在组头可访问名称的摘要中。
  const alertKind = summaryAlert === iconStatus ? null : summaryAlert;
  const alertLabel = alertKind === "error" ? t.tools.groupFailed(summary.failureCount)
    : alertKind === "unknown" ? t.tools.statusLabel(String(summary.unknownCount), t.tools.status.unknown)
      : alertKind === "interrupted" ? t.tools.groupInterrupted(summary.interruptedCount) : null;
  const ariaSummary = [summary.fullLabel, showWorking ? t.timeline.working : null].filter(Boolean).join(" · ");

  let copy: ReactNode;
  if (!state.expanded && active !== null) {
    copy = active.kind === "thinking"
      ? <ThinkingProcessHeading key={active.key} entry={active} status={activeStatus ?? "neutral"} />
      : <>
        <strong title={active.value.tool}>{active.value.tool}</strong>
        {toolDetail ? <span className="pwa-process-tool-detail" title={toolDetail}>{toolDetail}</span> : null}
        {state.additionalRunningTools > 0 ? <span className="pwa-process-more" role="status" aria-live="off" aria-label={t.timeline.otherRunningTools(state.additionalRunningTools)}>+{state.additionalRunningTools}</span> : null}
      </>;
  } else if (!state.expanded && showWorking) {
    copy = <span className="pwa-process-working">{t.timeline.working}</span>;
  } else {
    copy = <>
      <span className="pwa-process-summary" title={summary.fullLabel}>{summary.fullLabel}</span>
      {showWorking ? <span className="pwa-process-working">{t.timeline.working}</span> : null}
    </>;
  }
  if (active?.kind === "thinking" && !state.expanded && state.additionalRunningTools > 0) {
    copy = <>{copy}<span className="pwa-process-more" role="status" aria-live="off" aria-label={t.timeline.otherRunningTools(state.additionalRunningTools)}>+{state.additionalRunningTools}</span></>;
  }

  return <button className="pwa-process-head pwa-timeline-toggle" type="button" aria-expanded={state.expanded} aria-controls={detailsId} aria-label={t.tools.groupToggle(state.expanded, ariaSummary)} title={summary.fullLabel} onClick={() => onToggle(group.key, !state.expanded)}>
    <span className={`pwa-process-status-slot pwa-process-status-${iconStatus}`}><ProcessStatusIcon status={iconStatus} thinking={thinking} iconRef={indicatorRef} /></span>
    <span className="pwa-process-copy">{copy}</span>
    {alertKind === null ? null : <span className={`pwa-process-alert pwa-process-alert-${alertKind}`} role="img" aria-label={alertLabel ?? undefined}>
      {alertKind === "error" ? <CircleAlert size={16} aria-hidden="true" /> : alertKind === "unknown" ? <CircleHelp size={16} aria-hidden="true" /> : <CircleStop size={16} aria-hidden="true" />}
    </span>}
    <ChevronRight className="pwa-timeline-chevron" size={16} aria-hidden="true" />
  </button>;
}

/** 工具状态沿用真实状态；Thinking 的中性态不会出现在工具行。 */
const asToolStatus = (status: ProcessStatus): ToolStatus => status === "neutral" ? "unknown" : status;

/**
 * 过程组：固定左侧状态槽、同字号、单层总折叠与相邻明细短竖线。
 * 展开、业务状态与阅读意图均由父级模型提供，组件只负责呈现、焦点范围通知和真实图标可见性观察。
 */
export function ProcessGroup({ group, state, showWorking = false, onToggle, onRead, onFocusWithinChange, onRunningToolsChange, onPresentationChange }: ProcessGroupProps) {
  const { t } = useI18n();
  const summary = processGroupSummary(group, state.entryStatuses, t.tools);
  const detailsId = `pwa-process-${useId().replace(/:/g, "")}`;
  const { groupRef, register, observe } = useVisibleToolIndicators(group.key, onRunningToolsChange);

  const observeRef = useRef(observe);
  const presentationRef = useRef(onPresentationChange);
  useLayoutEffect(() => {
    observeRef.current = observe;
    presentationRef.current = onPresentationChange;
  });
  const presentation = useCallback(() => {
    observeRef.current();
    presentationRef.current?.();
  }, []);

  const focusRegion = useRef<HTMLDivElement>(null);
  const focusReported = useRef(false);
  const focusKey = useRef(group.key);
  const focusCallback = useRef(onFocusWithinChange);
  useLayoutEffect(() => {
    focusKey.current = group.key;
    focusCallback.current = onFocusWithinChange;
  });
  const reportFocus = useCallback((focused: boolean) => {
    if (focused === focusReported.current) return;
    focusReported.current = focused;
    focusCallback.current?.(focusKey.current, focused);
  }, []);
  // 聚焦成员的移除不保证有可观察的焦点事件，每次提交都核对明细范围。
  useLayoutEffect(() => {
    reportFocus(focusRegion.current?.contains(document.activeElement) ?? false);
  });
  useEffect(() => () => {
    if (!focusReported.current) return;
    focusReported.current = false;
    focusCallback.current?.(focusKey.current, false);
  }, [reportFocus]);
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    reportFocus(next instanceof Node && event.currentTarget.contains(next));
  };

  const only = group.entries.length === 1 ? group.entries[0]! : null;
  const staticTrace = only?.kind === "thinking" && !only.streaming && !only.text.trim()
    && !showWorking && state.additionalRunningTools === 0
    && summary.failureCount === 0 && summary.interruptedCount === 0 && summary.unknownCount === 0;

  if (staticTrace) {
    return <article ref={groupRef} className="pwa-process-group pwa-timeline-row" data-timeline-key={group.key} data-viewport-row={group.key} aria-label={t.timeline.processGroup}>
      <div className="pwa-process-head pwa-process-head-static">
        <span className="pwa-process-status-slot"><Lightbulb size={16} aria-hidden="true" /></span>
        <span>{t.timeline.thinkingTrace}</span>
      </div>
    </article>;
  }

  return <ToolIndicatorContext value={register}><article ref={groupRef} className="pwa-process-group pwa-timeline-row" data-timeline-key={group.key} data-viewport-row={group.key} aria-label={t.timeline.processGroup}>
    <ProcessGroupHead group={group} state={state} showWorking={showWorking} summary={summary} detailsId={detailsId} onToggle={onToggle} />
    <Collapse open={state.expanded} id={detailsId} className="pwa-process-details" onPresentationChange={presentation}>
      <div ref={focusRegion} className="pwa-process-entries" onFocusCapture={() => reportFocus(true)} onBlurCapture={handleBlur}>
        {group.entries.map(entry => <div key={entry.key} className="pwa-process-entry" data-process-entry-key={entry.key}>
          {entry.kind === "tool"
            ? <ToolCard value={entry.value} status={asToolStatus(state.entryStatuses.get(entry.key) ?? "neutral")} indicatorKeys={[entry.key]} onRead={trigger => onRead(entry, trigger)} />
            : <ThinkingProcessRow entry={entry} status={state.entryStatuses.get(entry.key) ?? "neutral"} onRead={trigger => onRead(entry, trigger)} />}
        </div>)}
      </div>
    </Collapse>
  </article></ToolIndicatorContext>;
}
