import { createContext, useContext, useState, type MouseEvent } from "react";
import { Lightbulb } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import type { ThinkingEntry } from "@/lib/pwa/timeline-presentation";
import { ThinkingTextParser } from "@/lib/pwa/thinking-text-parser";
import { Collapse } from "./collapse";
import type { ProcessStatus } from "./process-group-state";
import { ThinkingTailPreview, thinkingPreviewStart } from "./thinking-tail-preview";
import { useToolIndicatorRef } from "./tool-indicator-visibility";
import { useThinkingHeading } from "./use-thinking-heading";

const NO_KEYS: readonly string[] = [];

/**
 * 同一过程组内按思考条目共享解析器：标题在组头与明细行之间换位、或两处同时显示时，只扫描新增字符，不整段重扫。
 * 没有提供方时（组外复用）各自持有解析器。
 */
export const ThinkingParserContext = createContext<Map<string, ThinkingTextParser> | null>(null);

function useThinkingParser(key: string): ThinkingTextParser {
  const shared = useContext(ThinkingParserContext);
  const [local] = useState(() => new ThinkingTextParser());
  if (shared === null) return local;
  let parser = shared.get(key);
  if (parser === undefined) {
    parser = new ThinkingTextParser();
    shared.set(key, parser);
  }
  return parser;
}

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
  // 解析按数据是否仍在流式增长增量进行；展示状态只决定占位文案，被取代的缓冲尾巴也不能退回整段重扫。
  const epoch = entry.streaming ? entry.thinkingTextEpoch : undefined;
  const parser = useThinkingParser(entry.key);
  const parsed = parser.read(entry.text, epoch, entry.streaming);
  const heading = useThinkingHeading(parsed, entry.streaming, epoch);
  const title = heading ?? (running ? t.timeline.thinking : t.timeline.thinkingTrace);
  return <span className={className ? `pwa-process-thinking-heading ${className}` : "pwa-process-thinking-heading"} title={title}>{title}</span>;
}

type ThinkingProcessRowProps = {
  entry: ThinkingEntry;
  status: ProcessStatus;
  /** 标题已并入组头：运行期间本行只显示尾部预览，结束后标题淡入回到本行。 */
  headingInHead?: boolean;
  onRead: (trigger: HTMLButtonElement) => void;
};

/** 标题行之外还有正文时才显示尾部预览。 */
function hasPreview(text: string): boolean {
  return text.slice(thinkingPreviewStart(text)).replace(/^[ \t]*\*\*[^*\n].*\*\*[ \t]*$/gm, "").trim() !== "";
}

/**
 * 思考明细：整行打开阅读器；空文本只保留静态标题，不制造无效入口。运行中在标题下显示两行尾部预览，结束后收起。
 * 标题并入组头时本行只保留预览，两者都没有时整行隐藏（见 process-group.css）。
 */
export function ThinkingProcessRow({ entry, status, headingInHead = false, onRead }: ThinkingProcessRowProps) {
  const { t } = useI18n();
  const indicatorRef = useToolIndicatorRef(status === "running" && !headingInHead ? [entry.key] : NO_KEYS);
  const [previousInHead, setPreviousInHead] = useState(headingInHead);
  const [reveal, setReveal] = useState(false);
  if (previousInHead !== headingInHead) {
    setPreviousInHead(headingInHead);
    setReveal(!headingInHead);
  }
  const hasText = entry.text.trim() !== "";
  const body = <>
    <span className={`pwa-process-status-slot pwa-process-status-${status}`}><Lightbulb ref={indicatorRef} size={16} aria-hidden="true" /></span>
    <ThinkingProcessHeading entry={entry} status={status} />
  </>;
  const tailOpen = status === "running" && entry.streaming && hasPreview(entry.text);
  const tail = <Collapse open={tailOpen} className="pwa-thinking-tail-collapse"><ThinkingTailPreview text={entry.text} /></Collapse>;
  const read = (event: MouseEvent<HTMLButtonElement>) => onRead(event.currentTarget);
  if (headingInHead) {
    // 标题在组头时，预览本身就是阅读入口；预览未出现前本行为空，由样式隐藏。
    return <div className="pwa-thinking-process-row" data-heading-in-head="">
      {tailOpen ? <button className="pwa-thinking-tail-action" type="button" aria-haspopup="dialog" aria-label={t.timeline.readThinking} onClick={read}>{tail}</button> : tail}
    </div>;
  }
  const enter = reveal ? " pwa-row-enter" : "";
  return <div className="pwa-thinking-process-row">
    {hasText
      ? <button className={`pwa-thinking-process-row-action${enter}`} type="button" aria-haspopup="dialog" aria-label={t.timeline.readThinking} onClick={read}>{body}</button>
      : <div className={`pwa-thinking-process-row-static${enter}`}>{body}</div>}
    {tail}
  </div>;
}
