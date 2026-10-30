import { useState } from "react";
import { Lightbulb } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import type { ThinkingEntry } from "@/lib/pwa/timeline-presentation";
import { ThinkingTextParser } from "@/lib/pwa/thinking-text-parser";
import type { ProcessStatus } from "./process-group-state";
import { useToolIndicatorRef } from "./tool-indicator-visibility";
import { useThinkingHeading } from "./use-thinking-heading";

const NO_KEYS: readonly string[] = [];

type ThinkingProcessHeadingProps = {
  entry: ThinkingEntry;
  className?: string;
  /** 组头传入推导后的状态，避免缓冲尾巴或停机残留继续显示运行占位。 */
  status?: ProcessStatus;
};

/**
 * 过程组内的思考标题：复用现有解析器与 120ms 有界摘要合并，只输出稳定标题，
 * 不复制正文渲染，也不做槽位伸缩或标题位移。
 */
export function ThinkingProcessHeading({ entry, className, status }: ThinkingProcessHeadingProps) {
  const { t } = useI18n();
  const running = status === undefined ? entry.streaming : status === "running";
  const epoch = running ? entry.thinkingTextEpoch : undefined;
  const [parser] = useState(() => new ThinkingTextParser());
  const parsed = parser.read(entry.text, epoch, running);
  const heading = useThinkingHeading(parsed, running, epoch);
  const title = heading ?? (running ? t.timeline.thinking : t.timeline.thinkingTrace);
  return <span className={className ? `pwa-process-thinking-heading ${className}` : "pwa-process-thinking-heading"} title={title}>{title}</span>;
}

type ThinkingProcessRowProps = {
  entry: ThinkingEntry;
  status: ProcessStatus;
  onRead: (trigger: HTMLButtonElement) => void;
};

/** 思考明细：整行打开阅读器；空文本只保留静态标题，不制造无效入口。 */
export function ThinkingProcessRow({ entry, status, onRead }: ThinkingProcessRowProps) {
  const { t } = useI18n();
  const indicatorRef = useToolIndicatorRef(status === "running" ? [entry.key] : NO_KEYS);
  const body = <>
    <span className={`pwa-process-status-slot pwa-process-status-${status}`}><Lightbulb ref={indicatorRef} size={16} aria-hidden="true" /></span>
    <ThinkingProcessHeading entry={entry} status={status} />
  </>;
  return <div className="pwa-thinking-process-row">{entry.text.trim()
    ? <button className="pwa-thinking-process-row-action" type="button" aria-haspopup="dialog" aria-label={t.timeline.readThinking} onClick={event => onRead(event.currentTarget)}>{body}</button>
    : <div className="pwa-thinking-process-row-static">{body}</div>}</div>;
}
