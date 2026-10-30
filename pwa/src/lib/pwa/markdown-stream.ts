/** 流式正文的 Markdown 辅助：按安全块边界切分以缓存已完成段落，并标记新显示的文字供淡入。 */

export type MarkdownChunk = { text: string; offset: number };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** 空行后以缩进、列表项或表格行开头时可能延续上一块（列表松紧、续行、缩进代码），不在此切分。 */
const CONTINUES_BLOCK = /^(?:\s|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|\|)/;
/** 引用式链接定义与脚注会跨块引用，含有时整体解析。 */
const CROSS_BLOCK_REFERENCE = /^ {0,3}\[[^\]]+\]:|\[\^/m;
/** CommonMark 第 1—5 类原始 HTML 块可以跨空行，直到遇到对应的结束标记；第 6、7 类在空行处结束，不需要跟踪。 */
const HTML_BLOCKS: readonly { start: RegExp; end: RegExp }[] = [
  { start: /^ {0,3}<(?:pre|script|style|textarea)(?:\s|>|$)/i, end: /<\/(?:pre|script|style|textarea)>/i },
  { start: /^ {0,3}<!--/, end: /-->/ },
  { start: /^ {0,3}<\?/, end: /\?>/ },
  { start: /^ {0,3}<![A-Za-z]/, end: />/ },
  { start: /^ {0,3}<!\[CDATA\[/, end: /\]\]>/ },
];

/** 返回本行开启且未在本行结束的 HTML 块的结束标记；结束标记只在开始标记之后查找。 */
function openHtmlBlock(line: string): RegExp | null {
  for (const block of HTML_BLOCKS) {
    const start = block.start.exec(line);
    if (start) return block.end.test(line.slice(start[0].length)) ? null : block.end;
  }
  return null;
}

/**
 * 只在代码围栏与跨空行的原始 HTML 块之外、空行后紧跟独立块的位置切分；各块单独解析的 DOM 与整体解析一致。
 * 返回的块按原文顺序首尾相接，offset 为块在原文中的起点。
 */
export function splitMarkdownChunks(text: string): MarkdownChunk[] {
  if (CROSS_BLOCK_REFERENCE.test(text)) return [{ text, offset: 0 }];
  const chunks: MarkdownChunk[] = [];
  let start = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let htmlEnd: RegExp | null = null;
  let afterBlank = false;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const blank = line.trim() === "";
    if (fence === null && htmlEnd === null && afterBlank && !blank && !CONTINUES_BLOCK.test(line) && lineStart > start) {
      chunks.push({ text: text.slice(start, lineStart), offset: start });
      start = lineStart;
    }
    if (htmlEnd !== null) {
      if (htmlEnd.test(line)) htmlEnd = null;
    } else {
      const marker = FENCE.exec(line)?.[1];
      if (marker && fence === null) fence = marker;
      else if (marker && fence !== null && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      else if (fence === null) htmlEnd = openHtmlBlock(line);
    }
    if (!blank) afterBlank = false;
    else if (fence === null && htmlEnd === null) afterBlank = true;
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  chunks.push({ text: text.slice(start), offset: start });
  return chunks;
}

type HastPoint = { offset?: number };
type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start: HastPoint; end: HastPoint };
};

export const STREAM_REVEAL_CLASS = "pwa-stream-reveal";

export type StreamRevealOptions = {
  /** 本块原文，用于确认文本节点与原文逐字对应。 */
  source: string;
  /** 本块在整段正文中的起点。 */
  base: number;
  /** 各次新显示文字在整段正文中的起点，升序；每段延续到下一次起点。 */
  marks: readonly number[];
};

function revealSpan(mark: number, value: string): HastNode {
  return { type: "element", tagName: "span", properties: { className: [STREAM_REVEAL_CLASS], dataRevealOffset: String(mark) }, children: [{ type: "text", value }] };
}

/** 新显示片段所属的标记：起点不晚于 offset 的最后一个标记。 */
function markAt(marks: readonly number[], offset: number): number | undefined {
  let found: number | undefined;
  for (const mark of marks) {
    if (mark > offset) break;
    found = mark;
  }
  return found;
}

function splitText(node: HastNode, start: number, marks: readonly number[]): HastNode[] {
  const value = node.value ?? "";
  const end = start + value.length;
  const cuts = [start, ...marks.filter((mark) => mark > start && mark < end), end];
  const pieces: HastNode[] = [];
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const piece = value.slice(cuts[index] - start, cuts[index + 1] - start);
    if (!piece) continue;
    const mark = markAt(marks, cuts[index]);
    pieces.push(mark === undefined ? { type: "text", value: piece } : revealSpan(mark, piece));
  }
  return pieces;
}

function wrapChildren(node: HastNode, options: StreamRevealOptions, first: number): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    // 代码块由组件读取纯文本子节点，不插入包装元素。
    if (child.type === "element" && child.tagName === "pre") return [child];
    if (child.type !== "text") {
      wrapChildren(child, options, first);
      return [child];
    }
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (start === undefined || end === undefined || options.base + end <= first) return [child];
    // 转义或实体使节点文本与原文长度不同，只能整体归入一个片段。
    if (options.source.slice(start, end) !== child.value) {
      const mark = markAt(options.marks, options.base + start);
      return mark === undefined ? [child] : [revealSpan(mark, child.value ?? "")];
    }
    return splitText(child, options.base + start, options.marks);
  });
}

/** rehype 插件：把新显示的文字包进带标记的 span；不改变文字内容与块结构。 */
export function rehypeStreamReveal(options: StreamRevealOptions) {
  return (tree: HastNode) => {
    const first = options.marks[0];
    if (first === undefined) return;
    wrapChildren(tree, options, first);
  };
}
