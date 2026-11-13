import type { Ref } from "react";
import { CircleAlert, CircleHelp, CircleStop, Eye, FileDiff, LoaderCircle, Pencil, Search, Terminal, Wrench, type LucideIcon } from "lucide-react";

import { isToolPreparing, toolAction, toolCallCopy, toolDiffStats, toolIdentity, toolStatus, type ToolIconKind, type ToolStatus, type ToolValue } from "./tool-presentation";
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

// 只有修改用文件外形，内含 ± 与增删行数呼应；带加号的文件读作新建，且与 /new 命令图标相近，不用。
// 读取用眼睛、写入用铅笔、命令用不带框的提示符，16px 下靠外形而非细节区分。
const TOOL_TYPE_ICONS = { read: Eye, terminal: Terminal, search: Search, edit: FileDiff, write: Pencil, tool: Wrench } satisfies Record<ToolIconKind, LucideIcon>;

/** 工具类型图标：工具行成功时与整组同类工具成功时的组头共用。 */
export function ToolTypeIcon({ icon, iconRef }: { icon: ToolIconKind; iconRef?: Ref<SVGSVGElement> }) {
  const TypeIcon = TOOL_TYPE_ICONS[icon];
  return <TypeIcon ref={iconRef} size={16} aria-hidden="true" />;
}

/** 图标表示做了什么：成功时显示工具类型，运行、失败、中断与未知才换成状态图标。 */
function ToolStatusIcon({ status, icon, toolKeys }: { status: ToolStatus; icon: ToolIconKind; toolKeys: readonly string[] }) {
  const indicatorRef = useToolIndicatorRef(toolKeys);
  if (status === "running") return <LoaderCircle ref={indicatorRef} className="pwa-tool-spinner" size={16} aria-hidden="true" />;
  if (status === "error") return <CircleAlert size={16} aria-hidden="true" />;
  if (status === "interrupted") return <CircleStop size={16} aria-hidden="true" />;
  if (status === "unknown") return <CircleHelp size={16} aria-hidden="true" />;
  return <ToolTypeIcon icon={icon} />;
}

/**
 * 工具行与收起组头共用的文案：动词（无法分类时为工具名）、对象、修改工具真实返回的增删行数，最后是目录。
 * 动词与行数不参与省略；目录只占剩余空间，放不下时先于文件名省略。
 */
export function ToolCallCopy({ value }: { value: ToolValue }) {
  const { t } = useI18n();
  const copy = toolCallCopy(value);
  const stats = toolDiffStats(value);
  return <>
    <strong className={copy.kind === "generic" ? undefined : "pwa-tool-verb"} title={value.tool}>{copy.label}</strong>
    {copy.target ? <span className="pwa-tool-target" title={copy.title}>{copy.target}</span> : null}
    {stats ? <span className="pwa-tool-diff" title={t.tools.diffStats(stats.added, stats.removed)}>
      <span className="pwa-tool-diff-add">+{stats.added}</span>
      <span className="pwa-tool-diff-remove">−{stats.removed}</span>
    </span> : null}
    {copy.context ? <span className="pwa-tool-context" title={copy.title}><span className="pwa-tool-context-path">{copy.context}</span></span> : null}
  </>;
}

/** 完成的工具只显示类型图标，运行中、失败、中断与未知状态保留文字；各状态的可访问名称不变。 */
export function ToolCard({ value, onRead, status: statusOverride, timelineKey, indicatorKeys }: ToolCardProps) {
  const { t } = useI18n();
  const status = toolStatus(value, statusOverride);
  // 准备中按运行处理状态，只换图标颜色与读屏文案。
  const preparing = status === "running" && isToolPreparing(value);
  const statusText = preparing ? t.tools.preparing : status === "unknown" ? t.timeline.unknown : t.tools.status[status];

  return <article className={`pwa-tool-card pwa-tool-card-${status} pwa-timeline-row`} data-tool-status={status} data-tool-preparing={preparing ? "true" : undefined} data-tool-key={toolIdentity(value)} data-viewport-row={timelineKey}>
    <div className="pwa-tool-head">
      <button className="pwa-tool-action pwa-timeline-toggle pwa-timeline-heading" type="button" aria-label={t.tools.viewDetails(value.tool)} aria-haspopup="dialog" onClick={event => onRead(event.currentTarget)}>
        <span className="pwa-tool-action-copy"><ToolCallCopy value={value} /></span>
        <span className={`pwa-tool-status pwa-tool-status-${status}${preparing ? " pwa-tool-status-preparing" : ""}`} role="status" aria-label={t.tools.statusLabel(value.tool, preparing ? t.tools.preparing : t.tools.status[status])}><ToolStatusIcon status={status} icon={toolAction(value).icon} toolKeys={indicatorKeys ?? [toolIdentity(value)]} />{status === "complete" ? null : <span>{statusText}</span>}</span>
      </button>
    </div>
  </article>;
}
