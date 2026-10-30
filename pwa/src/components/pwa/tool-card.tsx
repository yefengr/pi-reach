import { Check, CircleAlert, CircleHelp, CircleStop, LoaderCircle } from "lucide-react";

import { toolHeaderSummary, toolIdentity, toolInlineText, toolStatus, type ToolStatus, type ToolValue } from "./tool-presentation";
import { useI18n } from "@/lib/i18n";
import { useToolIndicatorRef } from "./tool-indicator-visibility";
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
