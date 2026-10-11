import { useId, useState, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, CircleHelp, CircleStop, LoaderCircle } from "lucide-react";

import { toolAction, toolHeaderSummary, toolInlineText, toolStatus, type ToolKind, type ToolStatus, type ToolValue } from "./tool-presentation";
import { useI18n, type Messages } from "@/lib/i18n";
import { Collapse } from "./collapse";
import { currentTool, effectiveToolStatus } from "./tool-groups";
import "./tool-reader.css";

type ToolCardProps = {
  value: ToolValue;
  onRead: (trigger: HTMLButtonElement) => void;
  status?: ToolStatus;
};

/** 完成的工具只显示对勾，运行中、失败、中断与未知状态保留文字；各状态的可访问名称不变。 */
export function ToolCard({ value, onRead, status: statusOverride }: ToolCardProps) {
  const { t } = useI18n();
  const status = toolStatus(value, statusOverride);
  const summary = toolInlineText(toolHeaderSummary(value));

  return <article className={`pwa-tool-card pwa-tool-card-${status} pwa-timeline-row`} data-tool-status={status} data-tool-key={JSON.stringify([value.session_id, value.leaf_id, value.group_id, value.tool_call_id])}>
    <div className="pwa-tool-head">
      <button className="pwa-tool-action pwa-timeline-toggle pwa-timeline-heading" type="button" aria-label={t.tools.viewDetails(value.tool)} aria-haspopup="dialog" onClick={event => onRead(event.currentTarget)}>
        <span className="pwa-tool-action-copy"><strong title={value.tool}>{value.tool}</strong>{summary ? <span title={summary}>{summary}</span> : null}</span>
        <span className={`pwa-tool-status pwa-tool-status-${status}`} role="status" aria-label={t.tools.statusLabel(value.tool, t.tools.status[status])}>{status === "running" ? <LoaderCircle className="pwa-tool-spinner" size={16} aria-hidden="true" /> : status === "complete" ? <Check size={16} aria-hidden="true" /> : status === "error" ? <CircleAlert size={16} aria-hidden="true" /> : status === "interrupted" ? <CircleStop size={16} aria-hidden="true" /> : <CircleHelp size={16} aria-hidden="true" />}{status === "complete" ? null : <span>{status === "unknown" ? t.timeline.unknown : t.tools.status[status]}</span>}</span>
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

/** 组头当前工具：每次换成新的工具时从下方进入一次；组头首次出现时不播放。 */
function ToolGroupCurrent({ value, animate }: { value: ToolValue; animate: boolean }) {
  const summary = toolInlineText(toolHeaderSummary(value));
  return <span className="pwa-tool-group-current" data-enter={animate ? "" : undefined}>
    <LoaderCircle className="pwa-spin" size={16} aria-hidden="true" />
    <strong title={value.tool}>{value.tool}</strong>{summary ? <span title={summary}>{summary}</span> : null}
  </span>;
}

/**
 * 同一轮中相邻的工具从第一条起组成工具组。折叠时组头只显示最后开始、仍在运行的工具；它结束后回到分类摘要，
 * 组内仍有工具运行时摘要前保留旋转图标。展开时组头只显示摘要。含失败时显示错误图标，仅有中断时不显示。
 */
export function ToolGroupCard({ values, live, expanded, onExpandedChange, children }: { values: readonly ToolValue[]; live: boolean; expanded: boolean; onExpandedChange: (expanded: boolean) => void; children: ReactNode }) {
  const { t } = useI18n();
  const id = useId();
  const summary = toolGroupSummary(values, t.tools);
  const hasFailure = values.some(value => toolStatus(value) === "error");
  const running = currentTool(values, live);
  const runningKey = running ? JSON.stringify([running.group_id, running.tool_call_id]) : null;
  // 组头出现后当前工具第一次变化起才播放进入过渡；展开再收起不算变化。
  const [shown, setShown] = useState({ key: runningKey, animate: false });
  if (shown.key !== runningKey) setShown({ key: runningKey, animate: true });
  const current = expanded ? null : running;
  const busy = current === null && !expanded && values.some(value => effectiveToolStatus(value, live) === "running");
  const currentLabel = current ? t.tools.groupRunning(`${current.tool} ${toolInlineText(toolHeaderSummary(current))}`.trim()) : null;
  const detailsId = `pwa-tool-group-${id.replace(/:/g, "")}`;
  return <article className="pwa-tool-group pwa-timeline-row" data-tool-group-size={values.length}>
    <div className="pwa-tool-head">
      <button className="pwa-tool-action pwa-timeline-toggle pwa-timeline-heading" type="button" aria-label={t.tools.groupToggle(expanded, currentLabel ? `${currentLabel} · ${summary}` : summary)} aria-expanded={expanded} aria-controls={detailsId} onClick={() => onExpandedChange(!expanded)}>
        <span className="pwa-tool-action-copy">{current
          ? <ToolGroupCurrent key={runningKey} value={current} animate={shown.animate} />
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
