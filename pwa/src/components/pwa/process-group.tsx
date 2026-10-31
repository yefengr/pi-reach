import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, CircleHelp, CircleStop, Lightbulb, LoaderCircle } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import type { ThinkingEntry } from "@/lib/pwa/timeline-presentation";
import type { ThinkingTextParser } from "@/lib/pwa/thinking-text-parser";
import { Collapse } from "./collapse";
import { isSettleCollapse, processGroupSummary, type ProcessGroupState, type ProcessStatus } from "./process-group-state";
import type { ProcessEntry, ProcessGroup as ProcessGroupModel } from "./process-groups";
import { ThinkingParserContext, ThinkingProcessHeading, ThinkingProcessRow } from "./thinking-process-row";
import { ToolCard } from "./tool-card";
import { ToolIndicatorContext, useToolIndicatorRef, useVisibleToolIndicators, type RunningToolsChange } from "./tool-indicator-visibility";
import { isToolPreparing, toolHeaderSummary, toolInlineText, type ToolStatus } from "./tool-presentation";
import { usePwaMotionDuration } from "./use-pwa-motion";
import "./process-group.css";

export type { ProcessGroupModel };

const NO_KEYS: readonly string[] = [];

type ProcessGroupSummary = ReturnType<typeof processGroupSummary>;

type ProcessGroupProps = {
  group: ProcessGroupModel;
  state: ProcessGroupState;
  /** 在线会话中新追加的成员 key：新组整体淡入，已有组内的新成员单独淡入。 */
  enteredKeys?: ReadonlySet<string>;
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
  summary: ProcessGroupSummary;
  /** 并入组头的思考；为空时按当前活动或分类摘要显示。 */
  thinkingInHead: ThinkingEntry | null;
  detailsId: string;
  onToggle: (groupKey: string, expanded: boolean) => void;
};

/**
 * 组头承载的思考：运行中的当前思考无论展开与否都并入组头；
 * 没有工具的组结束并收起后保留最后一个有正文的思考标题，不退回固定的「Thinking」；
 * 展开时明细已逐条列出标题，组头与工具组一致显示分类摘要，避免同一标题重复。
 */
function headThinking(group: ProcessGroupModel, state: ProcessGroupState): ThinkingEntry | null {
  const active = state.activeEntry;
  if (active?.kind === "thinking" && state.entryStatuses.get(active.key) === "running") return active;
  if (active !== null || state.expanded || group.entries.some(entry => entry.kind === "tool")) return null;
  return group.entries.findLast((entry): entry is ThinkingEntry => entry.kind === "thinking" && entry.text.trim() !== "") ?? null;
}

/**
 * 自动收起播放期间冻结组头文案，等高度收拢后再换成新文案，避免与明细淡出、正文出现挤在同一帧。
 * 只在展开转为自动收起的那次提交开始冻结；冻结期间文案再变化直接采用最新值。
 */
function useSettleHeldKey(copyKey: string, expanded: boolean, settle: boolean): string {
  const duration = usePwaMotionDuration("--pwa-duration-collapse-settle");
  const [previousExpanded, setPreviousExpanded] = useState(expanded);
  const [lastKey, setLastKey] = useState(copyKey);
  const [held, setHeld] = useState<string | null>(null);
  let current = held;
  if (previousExpanded !== expanded) {
    setPreviousExpanded(expanded);
    current = !expanded && settle && lastKey !== copyKey ? lastKey : null;
    setHeld(current);
  } else if (held !== null && lastKey !== copyKey) {
    current = null;
    setHeld(null);
  }
  if (lastKey !== copyKey) setLastKey(copyKey);
  useEffect(() => {
    if (held === null) return;
    const timer = window.setTimeout(() => setHeld(null), duration);
    return () => window.clearTimeout(timer);
  }, [held, duration]);
  return current ?? copyKey;
}

/**
 * 组头只渲染推导好的内容：运行中的思考并入组头；其余收起时显示当前成员，展开时显示分类摘要；
 * 运行身份来自真实成员，不新增排队计时或调用轮播。
 */
function ProcessGroupHead({ group, state, summary, thinkingInHead, detailsId, onToggle }: ProcessGroupHeadProps) {
  const { t } = useI18n();
  const active = state.activeEntry;
  const activeStatus: ProcessStatus | null = active === null ? null : state.entryStatuses.get(active.key) ?? "neutral";
  const runningKeys = state.expanded
    ? group.entries.filter(entry => state.entryStatuses.get(entry.key) === "running").map(entry => entry.key)
    : active !== null && activeStatus === "running" ? [active.key] : NO_KEYS;
  // 没有具体运行成员时保持中性，避免给正文前的旧组挂运行状态；Working 只在时间线末尾兜底。
  const iconStatus: ProcessStatus = state.status === "running" && active === null ? "neutral" : state.status;
  const indicatorRef = useToolIndicatorRef(runningKeys);
  const thinking = active?.kind === "thinking" && activeStatus === "running";
  const preparing = active?.kind === "tool" && activeStatus === "running" && isToolPreparing(active.value);
  const summaryAlert = summary.failureCount > 0 ? "error" : summary.unknownCount > 0 ? "unknown" : summary.interruptedCount > 0 ? "interrupted" : null;
  // 左侧状态槽已表达同一状态时不再重复右侧图标；数量仍在组头可访问名称的摘要中。
  const alertKind = summaryAlert === iconStatus ? null : summaryAlert;
  const alertLabel = alertKind === "error" ? t.tools.groupFailed(summary.failureCount)
    : alertKind === "unknown" ? t.tools.statusLabel(String(summary.unknownCount), t.tools.status.unknown)
      : alertKind === "interrupted" ? t.tools.groupInterrupted(summary.interruptedCount) : null;
  const ariaSummary = summary.fullLabel;

  // 当前活动换人（思考、工具、摘要之间）时重新挂载并淡入；同一成员的标题与参数增长原位更新。
  const liveKey = thinkingInHead?.key ?? (!state.expanded && active !== null ? active.key : "summary");
  const copyKey = useSettleHeldKey(liveKey, state.expanded, isSettleCollapse(state));
  const [mountedCopyKey] = useState(copyKey);
  const shown = copyKey === "summary" ? null : group.entries.find(entry => entry.key === copyKey) ?? null;
  let copy: ReactNode;
  if (shown?.kind === "thinking") {
    copy = <ThinkingProcessHeading key={shown.key} entry={shown} status={state.entryStatuses.get(shown.key) ?? "neutral"} />;
  } else if (shown?.kind === "tool") {
    const toolDetail = toolInlineText(toolHeaderSummary(shown.value));
    copy = <>
      <strong title={shown.value.tool}>{shown.value.tool}</strong>
      {toolDetail ? <span className="pwa-process-tool-detail" title={toolDetail}>{toolDetail}</span> : null}
    </>;
  } else {
    copy = <span className="pwa-process-summary" title={summary.fullLabel}>{summary.fullLabel}</span>;
  }
  // 「+N」只在收起时补足看不到的并行工具；展开时明细已列出，冻结中的旧文案也不追加。
  if (!state.expanded && shown !== null && shown === active && state.additionalRunningTools > 0) {
    copy = <>{copy}<span className="pwa-process-more" role="status" aria-live="off" aria-label={t.timeline.otherRunningTools(state.additionalRunningTools)}>+{state.additionalRunningTools}</span></>;
  }

  return <button className="pwa-process-head pwa-timeline-toggle" type="button" aria-expanded={state.expanded} aria-controls={detailsId} aria-label={t.tools.groupToggle(state.expanded, ariaSummary)} title={summary.fullLabel} onClick={() => onToggle(group.key, !state.expanded)}>
    <span className={`pwa-process-status-slot pwa-process-status-${iconStatus}${preparing ? " pwa-process-status-preparing" : ""}`}><ProcessStatusIcon status={iconStatus} thinking={thinking} iconRef={indicatorRef} /></span>
    <span key={copyKey} className={`pwa-process-copy${copyKey === mountedCopyKey ? "" : " pwa-process-copy-swap"}`}>{copy}</span>
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
export function ProcessGroup({ group, state, enteredKeys, onToggle, onRead, onFocusWithinChange, onRunningToolsChange, onPresentationChange }: ProcessGroupProps) {
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

  const [parsers] = useState(() => new Map<string, ThinkingTextParser>());
  // 成员离开本组后释放其解析器；仍在的成员保留增量进度。
  useEffect(() => {
    const keys = new Set(group.entries.map(entry => entry.key));
    for (const key of parsers.keys()) if (!keys.has(key)) parsers.delete(key);
  });

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
  const groupEntering = enteredKeys?.has(group.entries[0]!.key) === true;
  const enterClass = groupEntering ? " pwa-row-enter" : "";
  const staticTrace = only?.kind === "thinking" && !only.streaming && !only.text.trim()
    && state.additionalRunningTools === 0
    && summary.failureCount === 0 && summary.interruptedCount === 0 && summary.unknownCount === 0;

  if (staticTrace) {
    return <article ref={groupRef} className={`pwa-process-group pwa-timeline-row${enterClass}`} data-timeline-key={group.key} data-viewport-row={group.key} aria-label={t.timeline.processGroup}>
      <div className="pwa-process-head pwa-process-head-static">
        <span className="pwa-process-status-slot"><Lightbulb size={16} aria-hidden="true" /></span>
        <span>{t.timeline.thinkingTrace}</span>
      </div>
    </article>;
  }

  const thinkingInHead = headThinking(group, state);
  // 仍有成员运行的组在末尾持续增长，声明为实时行，跟随时平滑接续。
  return <ThinkingParserContext value={parsers}><ToolIndicatorContext value={register}><article ref={groupRef} className={`pwa-process-group pwa-timeline-row${enterClass}`} data-timeline-key={group.key} data-viewport-row={group.key} data-viewport-live={state.status === "running" ? "true" : undefined} aria-label={t.timeline.processGroup}>
    <ProcessGroupHead group={group} state={state} summary={summary} thinkingInHead={thinkingInHead} detailsId={detailsId} onToggle={onToggle} />
    <Collapse open={state.expanded} id={detailsId} className="pwa-process-details" settle={isSettleCollapse(state)} onPresentationChange={presentation}>
      <div ref={focusRegion} className="pwa-process-entries" onFocusCapture={() => reportFocus(true)} onBlurCapture={handleBlur}>
        {group.entries.map((entry, index) => <div key={entry.key} className={`pwa-process-entry${index > 0 && enteredKeys?.has(entry.key) ? " pwa-row-enter" : ""}`} data-process-entry-key={entry.key}>
          {entry.kind === "tool"
            ? <ToolCard value={entry.value} status={asToolStatus(state.entryStatuses.get(entry.key) ?? "neutral")} indicatorKeys={[entry.key]} onRead={trigger => onRead(entry, trigger)} />
            : <ThinkingProcessRow entry={entry} status={state.entryStatuses.get(entry.key) ?? "neutral"} headingInHead={entry === thinkingInHead && state.entryStatuses.get(entry.key) === "running"} onRead={trigger => onRead(entry, trigger)} />}
        </div>)}
      </div>
    </Collapse>
  </article></ToolIndicatorContext></ThinkingParserContext>;
}
