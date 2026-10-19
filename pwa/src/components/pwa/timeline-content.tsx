import { isValidElement, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@mantine/core";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { useI18n } from "@/lib/i18n";
import { en } from "@/lib/i18n/messages/en";
import { highlightCode, languageForFence } from "@/lib/pwa/code-highlight";
import { CopyButton } from "./copy-button";
import { Collapse } from "./collapse";
import { markdownTableComponents } from "./markdown-table";
import { ThinkingTextParser } from "@/lib/pwa/thinking-text-parser";
import { useThinkingHeading } from "./use-thinking-heading";
export { thinkingTitle, thinkingSummary } from "@/lib/pwa/thinking-text-parser";
import "./timeline-content.css";

const PREVIEW_CHARACTERS = 2400;
const PREVIEW_LINES = 20;

type AssistantBlock = Extract<TimelineEvent, { kind: "assistant" }>["blocks"][number];

/** 顶部标题栏放围栏语言名与复制按钮，代码区只负责横向滚动，长行不会滚到按钮下方。 */
function CodeBlock({ text, language, label }: { text: string; language: string | undefined; label: string | undefined }) {
  const { t } = useI18n();
  const html = useMemo(() => highlightCode(text, language), [language, text]);
  return <div className="pwa-code-block">
    <div className="pwa-code-head">
      <span className="pwa-code-language">{label}</span>
      <CopyButton className="pwa-code-copy" text={text} label={t.timeline.copyCode} />
    </div>
    <pre>{html === undefined ? <code>{text}</code> : <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: html }} />}</pre>
  </div>;
}

const markdownComponents: Components = {
  // 链接在新标签页打开，不向目标页暴露来源窗口。
  a: ({ href, title, children }) => <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>,
  pre: ({ children }) => {
    const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children.props : null;
    const text = String(code?.children ?? "").replace(/\n$/, "");
    const fence = /(?:^|\s)language-([\w+#.-]+)/.exec(code?.className ?? "")?.[1];
    return <CodeBlock text={text} language={languageForFence(fence)} label={fence?.trim().toLowerCase() || undefined} />;
  },
  ...markdownTableComponents,
};

export function MarkdownContent({ text }: { text: string }) {
  return <div className="pwa-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{text}</ReactMarkdown></div>;
}

/** 保留正文顺序，仅将相邻同类片段合并为一个阅读区域。 */
function adjacentBlocks(blocks: readonly AssistantBlock[]): AssistantBlock[] {
  const merged: AssistantBlock[] = [];
  for (const block of blocks) {
    if (!block.text.trim()) continue;
    const previous = merged.at(-1);
    if (previous?.type === block.type) previous.text += `\n${block.text}`;
    else merged.push({ ...block });
  }
  return merged;
}

type LongTextProps = {
  text: string;
  label: string;
  variant?: "code" | "prose";
  toggleLabels?: { showFull: string; showLess: string };
};

export function LongText({ text, label, variant = "code", toggleLabels }: LongTextProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const firstLines = text.split("\n", PREVIEW_LINES).join("\n");
  let end = Math.min(firstLines.length, PREVIEW_CHARACTERS);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xD800 && last <= 0xDBFF) end -= 1;
  const long = end < text.length;
  const shown = expanded || !long ? text : text.slice(0, end);
  return <div className="pwa-long-text">
    {variant === "prose"
      // 思考正文与回复共用同一 Markdown 渲染；容器仍是 14px 次级文字，块级元素不放大。
      ? <div id={id} className={`pwa-text-plain${expanded ? " expanded" : ""}`}><MarkdownContent text={shown} /></div>
      : <pre id={id} className={`pwa-tool-code${expanded ? " expanded" : ""}`}>{shown}</pre>}
    {long ? <Button variant="transparent" color="piReach" className="pwa-output-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}>{expanded ? toggleLabels?.showLess ?? t.timeline.showLess(label) : toggleLabels?.showFull ?? t.timeline.showFull(label)}</Button> : null}
  </div>;
}

type ThinkingContentProps = {
  text: string;
  streaming?: boolean;
  thinkingTextEpoch?: object;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  timelineKey?: string;
};

export function ThinkingContent({ text, streaming = false, thinkingTextEpoch, expanded: controlledExpanded, onExpandedChange, timelineKey }: ThinkingContentProps) {
  const { t } = useI18n();
  const [parser] = useState(() => new ThinkingTextParser());
  const parsed = parser.read(text, streaming ? thinkingTextEpoch : undefined, streaming);
  const heading = useThinkingHeading(parsed, streaming, thinkingTextEpoch);
  const [localExpanded, setLocalExpanded] = useState(false);
  const [previousStreaming, setPreviousStreaming] = useState(streaming);
  const [announcementReady, setAnnouncementReady] = useState(false);
  if (previousStreaming !== streaming) {
    setPreviousStreaming(streaming);
    setAnnouncementReady(false);
  }
  useEffect(() => {
    if (!streaming) return;
    // 先让空 live region 经过一帧供辅助技术登记，再只写入一次状态；增量不重启公告。
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setAnnouncementReady(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [streaming]);
  const expanded = controlledExpanded ?? localExpanded;
  const id = useId();
  const setExpanded = (next: boolean) => { setLocalExpanded(next); onExpandedChange?.(next); };
  if (!streaming && parsed.empty) return <section className="pwa-thinking pwa-thinking-trace pwa-timeline-row" data-timeline-key={timelineKey}>
    <div className="pwa-thinking-title pwa-timeline-heading">{t.timeline.thinkingTrace}</div>
  </section>;
  const title = heading ?? (streaming ? t.timeline.thinking : t.timeline.thoughtProcess);
  return <section className="pwa-thinking pwa-timeline-row" data-timeline-key={timelineKey}>
    <button className="pwa-thinking-head pwa-message-toggle pwa-timeline-toggle pwa-timeline-heading" type="button" aria-label={expanded ? t.timeline.collapseThinking : t.timeline.expandThinking} aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
      <span className={`pwa-thinking-title pwa-thinking-heading${streaming ? " pwa-thinking-live" : ""}`} title={streaming ? undefined : title} aria-live={streaming ? "off" : undefined}>
        <i className="pwa-thinking-icon-slot" aria-hidden="true"><LoaderCircle className={streaming ? "pwa-spin" : undefined} size={16} aria-hidden="true" /></i>
        <span title={title}>{title}</span>
      </span>
      <ChevronRight className="pwa-timeline-chevron" size={16} aria-hidden="true" />
    </button>
    {/* 独立的稳定状态保留读屏提示，不随视觉标题的流式增量重复播报。 */}
    {streaming ? <span className="pwa-sr-only" role="status">{announcementReady ? t.timeline.thinking : ""}</span> : null}
    <Collapse open={expanded} id={id} className="pwa-thinking-content"><LongText text={text} label={t.timeline.thinkingLabel} variant="prose" toggleLabels={{ showFull: en.timeline.showFull(en.timeline.thinkingLabel), showLess: en.timeline.showLess(en.timeline.thinkingLabel) }} /></Collapse>
  </section>;
}

export function AssistantBlocks({ blocks, streaming = false }: { blocks: readonly AssistantBlock[]; streaming?: boolean }) {
  return <div className="pwa-assistant-blocks">{adjacentBlocks(blocks).map((block, index) => block.type === "thinking"
    ? <ThinkingContent key={index} text={block.text} streaming={streaming} />
    : <div key={index}><MarkdownContent text={block.text} /></div>)}</div>;
}
