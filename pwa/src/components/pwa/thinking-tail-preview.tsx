import { useRef, type ReactNode } from "react";
import { STREAM_REVEAL_CLASS } from "@/lib/pwa/markdown-stream";
import { useStreamRevealAnimation, useStreamRevealMarks } from "./use-stream-reveal";

/** 只取正文末尾这么多字符：两行预览之外的内容由顶部渐隐裁掉，不为长思考重复排版全文。 */
const TAIL_CHARS = 320;

/** 整行加粗标题：已作为思考标题显示。 */
const HEADING_LINE = /^[ \t]*\*\*[^*\n].*\*\*[ \t]*$/gm;
/** 判断是否存在标题行；不带 g 标志，避免 test 的 lastIndex 状态影响下一次调用。 */
const HAS_HEADING_LINE = /^[ \t]*\*\*[^*\n].*\*\*[ \t]*$/m;

/** 预览是纯文本：去掉加粗与行内代码标记，合并空行，不解析 Markdown。 */
function plain(text: string): string {
  return text.replace(/\*\*|`/g, "").replace(/\n{2,}/g, "\n");
}

/**
 * 标题行之外的正文起点：有整行加粗标题时只去掉标题行，否则跳过已作为单行摘要显示的首个非空行，
 * 预览不重复标题区已显示的文字。
 */
export function thinkingPreviewStart(text: string): number {
  if (HAS_HEADING_LINE.test(text)) return 0;
  const first = /\S[^\n]*(\n|$)/.exec(text);
  return first ? first.index + first[0].length : text.length;
}

/**
 * 运行中思考的尾部预览：固定两行高度、最新内容贴底，新放出的文字按流式片段淡入。
 * 只作视觉进度，对读屏隐藏；全文仍从思考阅读器查看。
 */
export function ThinkingTailPreview({ text }: { text: string }) {
  const root = useRef<HTMLDivElement>(null);
  const marks = useStreamRevealMarks(text, true);
  useStreamRevealAnimation(root, marks);
  const start = Math.max(thinkingPreviewStart(text), text.length - TAIL_CHARS);
  // 标题行按全文定位后整段跳过；淡入片段可能切开标题行，不能在片段内各自匹配。
  const headings = [...text.matchAll(HEADING_LINE)].map(match => [match.index, match.index + match[0].length] as const);
  const shown = (from: number, to: number) => {
    let value = "";
    let cursor = from;
    for (const [headingStart, headingEnd] of headings) {
      if (headingEnd <= cursor || headingStart >= to) continue;
      value += text.slice(cursor, Math.max(cursor, headingStart));
      cursor = Math.max(cursor, headingEnd);
    }
    return value + text.slice(Math.min(cursor, to), to);
  };
  // 片段边界：窗口起点与窗口内的新显示标记；窗口外开始的片段从窗口起点截取。
  const bounds = [start, ...marks.filter(mark => mark > start)];
  const parts: ReactNode[] = bounds.map((from, index) => {
    const to = bounds[index + 1] ?? text.length;
    const value = plain(shown(from, to));
    if (!value) return null;
    const revealed = index > 0 || marks.includes(from);
    return revealed
      ? <span key={from} className={STREAM_REVEAL_CLASS} data-reveal-offset={from}>{value}</span>
      : <span key={from}>{value}</span>;
  });
  return <div ref={root} className="pwa-thinking-tail" aria-hidden="true"><p>{parts}</p></div>;
}
