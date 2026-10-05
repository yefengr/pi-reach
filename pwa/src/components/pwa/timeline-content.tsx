import { isValidElement, useId, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@mantine/core";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { useI18n } from "@/lib/i18n";
import { highlightCode, languageForFence } from "@/lib/pwa/code-highlight";
import { CopyButton } from "./copy-button";
import { Collapse } from "./collapse";
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
  table: ({ children }) => <div className="pwa-markdown-table"><table>{children}</table></div>,
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

export function LongText({ text, label, variant = "code" }: { text: string; label: string; variant?: "code" | "prose" }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const firstLines = text.split("\n", PREVIEW_LINES).join("\n");
  let end = Math.min(firstLines.length, PREVIEW_CHARACTERS);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xD800 && last <= 0xDBFF) end -= 1;
  const long = end < text.length;
  return <div className="pwa-long-text">
    <pre id={id} className={`${variant === "prose" ? "pwa-text-plain" : "pwa-tool-code"}${expanded ? " expanded" : ""}`}>{expanded || !long ? text : text.slice(0, end)}</pre>
    {long ? <Button variant="transparent" color="piReach" className="pwa-output-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}>{expanded ? t.timeline.showLess(label) : t.timeline.showFull(label)}</Button> : null}
  </div>;
}

type ThinkingContentProps = {
  text: string;
  streaming?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  timelineKey?: string;
};

/** 推理文本里整行加粗（`**标题**`）的标题；结束后取第一个，流式阶段取目前最新的一个。标题是模型原文，不翻译。 */
export function thinkingTitle(text: string, streaming: boolean): string | undefined {
  const titles = [...text.matchAll(/^[ \t]*\*\*([^*\n]+?)\*\*[ \t]*$/gm)].map(match => match[1]!.trim()).filter(Boolean);
  return streaming ? titles.at(-1) : titles[0];
}

export function ThinkingContent({ text, streaming = false, expanded: controlledExpanded, onExpandedChange, timelineKey }: ThinkingContentProps) {
  const { t } = useI18n();
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const id = useId();
  const setExpanded = (next: boolean) => { setLocalExpanded(next); onExpandedChange?.(next); };
  const title = thinkingTitle(text, streaming) ?? t.timeline.thoughtProcess;
  return <section className="pwa-thinking pwa-timeline-row" data-timeline-key={timelineKey}>
    <button className="pwa-thinking-head pwa-message-toggle pwa-timeline-toggle pwa-timeline-heading" type="button" aria-label={expanded ? t.timeline.collapseThinking : t.timeline.expandThinking} aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
      <span className="pwa-thinking-title" title={title}>{title}</span>
      {streaming ? <span className="pwa-thinking-live" role="status"><LoaderCircle className="pwa-spin" size={16} aria-hidden="true" />{t.timeline.thinking}</span> : null}
      <ChevronRight className="pwa-timeline-chevron" size={16} aria-hidden="true" />
    </button>
    <Collapse open={expanded} id={id} className="pwa-thinking-content"><LongText text={text} label={t.timeline.thinkingLabel} variant="prose" /></Collapse>
  </section>;
}

export function AssistantBlocks({ blocks, streaming = false }: { blocks: readonly AssistantBlock[]; streaming?: boolean }) {
  return <div className="pwa-assistant-blocks">{adjacentBlocks(blocks).map((block, index) => block.type === "thinking"
    ? <ThinkingContent key={index} text={block.text} streaming={streaming} />
    : <div key={index}><MarkdownContent text={block.text} /></div>)}</div>;
}
