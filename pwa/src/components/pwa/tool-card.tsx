import { useEffect, useId, useState, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, CircleHelp, CircleStop, LoaderCircle } from "lucide-react";

import { toolAction, toolHeaderSummary, toolIdentity, toolInlineText, toolStatus, type ToolKind, type ToolStatus, type ToolValue } from "./tool-presentation";
import { useI18n, type Messages } from "@/lib/i18n";
import { Collapse } from "./collapse";
import { currentTool, effectiveToolStatus } from "./tool-groups";
import "./tool-reader.css";

type ToolCardProps = {
  value: ToolValue;
  onRead: (trigger: HTMLButtonElement) => void;
  status?: ToolStatus;
};

function ToolStatusIcon({ status }: { status: ToolStatus }) {
  if (status === "running") return <LoaderCircle className="pwa-tool-spinner" size={16} aria-hidden="true" />;
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
        <span className={`pwa-tool-status pwa-tool-status-${status}`} role="status" aria-label={t.tools.statusLabel(value.tool, t.tools.status[status])}><ToolStatusIcon status={status} />{status === "complete" ? null : <span>{status === "unknown" ? t.timeline.unknown : t.tools.status[status]}</span>}</span>
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

/** 组头工具结束后的最短停留时间：快速完成的工具也能被看清；停留期间有新工具开始则立即替换。 */
const GROUP_HEAD_MIN_VISIBLE_MS = 1500;

/** 组头工具：每次换成新的工具时从下方进入一次，组头首次出现时不播放；停留中的已结束工具显示其结束状态图标。 */
function ToolGroupCurrent({ value, status, animate }: { value: ToolValue; status: ToolStatus; animate: boolean }) {
  const summary = toolInlineText(toolHeaderSummary(value));
  return <span className="pwa-tool-group-current" data-enter={animate ? "" : undefined}>
    <span className={`pwa-tool-status pwa-tool-status-${status}`}><ToolStatusIcon status={status} /></span>
    <strong title={value.tool}>{value.tool}</strong>{summary ? <span title={summary}>{summary}</span> : null}
  </span>;
}

/**
 * 组头显示的工具：最后开始、仍在运行的工具立即显示；它结束后再停留到出现满 GROUP_HEAD_MIN_VISIBLE_MS，
 * 之后回到摘要。较早开始、仍在运行的工具不回到组头。`animate` 表示组头出现后发生过切换。
 */
function useGroupHeadTool(values: readonly ToolValue[], live: boolean): { value: ToolValue | null; animate: boolean } {
  const running = currentTool(values, live);
  const runningKey = running ? toolIdentity(running) : null;
  const [head, setHead] = useState({ key: runningKey, animate: false });
  if (runningKey !== null && head.key !== runningKey) setHead({ key: runningKey, animate: true });
  // 记录已满最短停留时间的工具；计时从它进入组头时开始。
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    const key = head.key;
    if (key === null) return;
    const timer = window.setTimeout(() => setSettled(key), GROUP_HEAD_MIN_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [head.key]);
  if (running) return { value: running, animate: head.animate };
  const held = live && head.key !== null && settled !== head.key ? values.find(value => toolIdentity(value) === head.key) ?? null : null;
  return { value: held, animate: head.animate };
}

/**
 * 同一轮中相邻的工具从第一条起组成工具组。折叠时组头显示最后开始的工具，它结束后至少停留 GROUP_HEAD_MIN_VISIBLE_MS
 * 再回到分类摘要；组内仍有工具运行时摘要前保留旋转图标。展开时组头只显示摘要。含失败时显示错误图标，仅有中断时不显示。
 */
export function ToolGroupCard({ values, live, expanded, onExpandedChange, children }: { values: readonly ToolValue[]; live: boolean; expanded: boolean; onExpandedChange: (expanded: boolean) => void; children: ReactNode }) {
  const { t } = useI18n();
  const id = useId();
  const summary = toolGroupSummary(values, t.tools);
  const hasFailure = values.some(value => toolStatus(value) === "error");
  const head = useGroupHeadTool(values, live);
  const current = expanded ? null : head.value;
  const currentStatus = current ? effectiveToolStatus(current, live) : null;
  const busy = current === null && !expanded && values.some(value => effectiveToolStatus(value, live) === "running");
  const currentLabel = current && currentStatus === "running" ? t.tools.groupRunning(`${current.tool} ${toolInlineText(toolHeaderSummary(current))}`.trim()) : null;
  const detailsId = `pwa-tool-group-${id.replace(/:/g, "")}`;
  return <article className="pwa-tool-group pwa-timeline-row" data-tool-group-size={values.length}>
    <div className="pwa-tool-head">
      <button className="pwa-tool-action pwa-timeline-toggle pwa-timeline-heading" type="button" aria-label={t.tools.groupToggle(expanded, currentLabel ? `${currentLabel} · ${summary}` : summary)} aria-expanded={expanded} aria-controls={detailsId} onClick={() => onExpandedChange(!expanded)}>
        <span className="pwa-tool-action-copy">{current
          ? <ToolGroupCurrent key={toolIdentity(current)} value={current} status={currentStatus!} animate={head.animate} />
          : <span className="pwa-tool-group-summary" title={summary}>{busy ? <LoaderCircle className="pwa-spin" size={16} aria-hidden="true" /> : null}<span className="pwa-tool-group-summary-text">{summary}</span></span>}</span>
        {hasFailure ? <CircleAlert className="pwa-tool-group-alert" size={16} aria-hidden="true" /> : null}
        <ChevronRight className="pwa-tool-chevron pwa-timeline-chevron" size={16} aria-hidden="true" />
      </button>
    </div>
    <Collapse open={expanded} id={detailsId} className="pwa-tool-group-details">
      {children}
    </Collapse>
  </article>;
}
