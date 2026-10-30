import { Fragment, isValidElement, memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options as MarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "@/lib/i18n";
import { highlightCode, languageForFence } from "@/lib/pwa/code-highlight";
import { CopyButton } from "./copy-button";
import { markdownTableComponents } from "./markdown-table";
import { rehypeStreamReveal, splitMarkdownChunks, type MarkdownChunk } from "@/lib/pwa/markdown-stream";
export { thinkingTitle, thinkingSummary } from "@/lib/pwa/thinking-text-parser";
import "./timeline-content.css";

/** 顶部标题栏放围栏语言名与复制按钮，代码区只负责横向滚动，长行不会滚到按钮下方。 */
// 流式追加只改变消息尾部时，闭合代码块的三个标量输入不变；memo 保留其 DOM、复制状态与高亮缓存。
const CodeBlock = memo(function CodeBlock({ text, language, label }: { text: string; language: string | undefined; label: string | undefined }) {
  const { t } = useI18n();
  const html = useMemo(() => highlightCode(text, language), [language, text]);
  return <div className="pwa-code-block">
    <div className="pwa-code-head">
      <span className="pwa-code-language">{label}</span>
      <CopyButton className="pwa-code-copy" text={text} label={t.timeline.copyCode} />
    </div>
    <pre>{html === undefined ? <code>{text}</code> : <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: html }} />}</pre>
  </div>;
});

const remarkPlugins = [remarkGfm];

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

const NO_MARKS: readonly number[] = [];

function sameMarks(a: readonly number[], b: readonly number[]): boolean {
  return a === b || a.length === b.length && a.every((mark, index) => mark === b[index]);
}

/** 只保留与本块重叠的新显示片段；每段从标记起点延续到下一个标记或正文末尾。 */
function chunkMarks(marks: readonly number[], chunk: MarkdownChunk, textLength: number): readonly number[] {
  const chunkEnd = chunk.offset + chunk.text.length;
  const overlapping = marks.filter((mark, index) => mark < chunkEnd && (marks[index + 1] ?? textLength) > chunk.offset);
  return overlapping.length ? overlapping : NO_MARKS;
}

type MarkdownChunkProps = { text: string; base: number; marks: readonly number[] };

// 流式追加通常只改变最后一块；已完成的块按文本与片段标记比较，不重新解析 Markdown。
const MarkdownChunkView = memo(function MarkdownChunkView({ text, base, marks }: MarkdownChunkProps) {
  const rehypePlugins: MarkdownOptions["rehypePlugins"] = marks.length ? [[rehypeStreamReveal, { source: text, base, marks }]] : undefined;
  return <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>{text}</ReactMarkdown>;
}, (a, b) => a.text === b.text && a.base === b.base && sameMarks(a.marks, b.marks));

/** 历史消息正文在流式追加时保持不变；reveal 为流式新显示文字的起点，用于淡入。 */
export const MarkdownContent = memo(function MarkdownContent({ text, reveal = NO_MARKS }: { text: string; reveal?: readonly number[] }) {
  const chunks = useMemo(() => splitMarkdownChunks(text), [text]);
  // 整体解析在相邻块之间留一个换行文本节点；分块渲染保持同样的 DOM 与 textContent。
  return <div className="pwa-markdown">{chunks.map((chunk, index) => <Fragment key={index}>
    {index > 0 ? "\n" : null}
    <MarkdownChunkView text={chunk.text} base={chunk.offset} marks={chunkMarks(reveal, chunk, text.length)} />
  </Fragment>)}</div>;
});
