import { useId, useState, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, CircleHelp, LoaderCircle } from "lucide-react";

import { ToolPreview } from "./tool-preview";
import { isToolPartial, toolAction, toolHeaderSummary, toolInlineText, toolStatus, type ToolKind, type ToolStatus, type ToolValue } from "./tool-presentation";
import { useI18n, type Messages } from "@/lib/i18n";
import { Collapse } from "./collapse";
import "./tool-reader.css";

type ToolCardProps = {
  value: ToolValue;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onRead?: (trigger: HTMLButtonElement) => void;
  status?: ToolStatus;
};

/** 完成的工具只显示对勾，运行中、失败、中断与未知状态保留文字；各状态的可访问名称不变。 */
export function ToolCard({ value, expanded: controlledExpanded, onExpandedChange, onRead, status: statusOverride }: ToolCardProps) {
  const { t } = useI18n();
  const id = useId();
  const status = toolStatus(value, statusOverride);
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const summary = toolInlineText(toolHeaderSummary(value));
  const detailsId = `pwa-tool-details-${id.replace(/:/g, "")}`;
  const setExpanded = (next: boolean) => { setLocalExpanded(next); onExpandedChange?.(next); };

  return <article className={`pwa-tool-card pwa-tool-card-${status} pwa-timeline-row`} data-tool-status={status} data-tool-key={JSON.stringify([value.session_id, value.leaf_id, value.group_id, value.tool_call_id])}>
    <div className="pwa-tool-head">
      <button className="pwa-tool-action pwa-timeline-toggle pwa-timeline-heading" type="button" aria-label={t.tools.toggle(expanded, value.tool)} aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>
        <ChevronRight className="pwa-tool-chevron pwa-timeline-chevron" size={16} aria-hidden="true" />
        <span className="pwa-tool-action-copy"><strong title={value.tool}>{value.tool}</strong>{summary ? <span title={summary}>{summary}</span> : null}</span>
        <span className={`pwa-tool-status pwa-tool-status-${status}`} role="status" aria-label={t.tools.statusLabel(value.tool, t.tools.status[status])}>{status === "running" ? <LoaderCircle className="pwa-tool-spinner" size={16} aria-hidden="true" /> : status === "complete" ? <Check size={16} aria-hidden="true" /> : status === "error" || status === "interrupted" ? <CircleAlert size={16} aria-hidden="true" /> : <CircleHelp size={16} aria-hidden="true" />}{status === "complete" ? null : <span>{status === "unknown" ? t.timeline.unknown : t.tools.status[status]}</span>}</span>
      </button>
    </div>
    <Collapse open={expanded} id={detailsId} className="pwa-tool-details pwa-timeline-content">
      <ToolPreview value={value} onRead={onRead} />
      {isToolPartial(value) ? <span className="pwa-tool-live-note">{t.tools.stillArriving}</span> : null}
    </Collapse>
  </article>;
}

/** 连续成功工具的摘要：按类别计数、按首次出现排序；读取、修改、写入按不同路径计数。 */
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
  return order.map((kind) => label[kind](kind === "read" || kind === "edit" || kind === "write" ? paths.get(kind)!.size : calls.get(kind)!)).join(" · ");
}

/** 同一轮中相邻且都已成功完成的工具合并为一行摘要，展开后是原有的逐条工具行。 */
export function ToolGroupCard({ values, expanded, onExpandedChange, children }: { values: readonly ToolValue[]; expanded: boolean; onExpandedChange: (expanded: boolean) => void; children: ReactNode }) {
  const { t } = useI18n();
  const id = useId();
  const summary = toolGroupSummary(values, t.tools);
  const detailsId = `pwa-tool-group-${id.replace(/:/g, "")}`;
  return <article className="pwa-tool-group pwa-timeline-row" data-tool-group-size={values.length}>
    <div className="pwa-tool-head">
      <button className="pwa-tool-action pwa-timeline-toggle pwa-timeline-heading" type="button" aria-label={t.tools.groupToggle(expanded, summary)} aria-expanded={expanded} aria-controls={detailsId} onClick={() => onExpandedChange(!expanded)}>
        <ChevronRight className="pwa-tool-chevron pwa-timeline-chevron" size={16} aria-hidden="true" />
        <span className="pwa-tool-action-copy"><span className="pwa-tool-group-summary" title={summary}>{summary}</span></span>
        <span className="pwa-tool-status pwa-tool-status-complete" role="status" aria-label={t.tools.groupStatus(values.length)}><Check size={16} aria-hidden="true" /></span>
      </button>
    </div>
    <Collapse open={expanded} id={detailsId} className="pwa-tool-group-details">
      {children}
    </Collapse>
  </article>;
}
