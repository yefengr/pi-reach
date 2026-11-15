import {
  isRecord,
  toolAction,
  toolContentBlocks,
  toolInput,
  toolOutputBlocks,
  toolResult,
  toolStatus,
  toolWasTruncated,
  type ToolContentBlock,
  type ToolValue,
} from "./tool-presentation";

export type ReadToolContent = {
  text: string;
  startLine?: number;
  endLine?: number;
  notice?: string;
  partial: boolean;
};

type OffsetState = { state: "absent" } | { state: "invalid" } | { state: "valid"; line: number };

const OFFSET_KEYS = ["offset", "start_line", "startLine"] as const;

// Pi 在正文末尾另起一段追加续读提示；只匹配三种真实形式，且必须紧贴文本末尾。
const CONTINUATION_NOTICE =
  /\n\n(\[(?:Showing lines (\d+)-(\d+) of (\d+)(?: \([^)\n]+ limit\))?|(\d+) more lines in file)\. Use offset=(\d+) to continue\.\])$/;
// 首行本身超过字节上限时，整段结果只有这一条提示，没有任何文件正文。
const BYTE_LIMIT_NOTICE = /^\[Line \d+ is [^\n]+, exceeds [^\n]+ limit\. Use bash: [^\n]+\]$/;
// 图片处理失败时 SDK 仍返回成功文本，只带这一行说明，不能当作文件正文。
const READ_IMAGE_NOTE = /^Read image file \[[^\]\n]+\]/;
// 内置 edit／write 的成功回执原文；未知或自定义回执保留。
const EDIT_SUCCESS_RECEIPT = /^Successfully replaced \d+ block\(s\) in [^\n]+\.$/;
const WRITE_SUCCESS_RECEIPT = /^Successfully wrote to [^\n]+$/;

/** 只接受真正的正整数起始行；显式传入 0、负数、小数或字符串都视为不可靠。 */
function readOffset(value: ToolValue): OffsetState {
  const args = toolInput(value);
  if (!isRecord(args)) return { state: "absent" };
  for (const key of OFFSET_KEYS) {
    if (!(key in args)) continue;
    const offset = args[key];
    if (typeof offset === "number" && Number.isSafeInteger(offset) && offset > 0) return { state: "valid", line: offset };
    return { state: "invalid" };
  }
  return { state: "absent" };
}

function positiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 行数按渲染语义计算：末尾单个换行符不额外算一行，但正文中的空行照常计数。 */
export function countTextLines(text: string): number {
  if (text === "") return 0;
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").length;
}

/**
 * 只从真实 result 提取 read 的单一文本内容，并把末尾续读提示分离出来。
 * 无法可靠编号时不返回行范围；提示本身保留，不吞掉真实内容。
 */
export function readToolContent(value: ToolValue): ReadToolContent | undefined {
  if (toolAction(value).kind !== "read") return undefined;
  if (toolStatus(value) === "error") return undefined;
  const blocks = toolOutputBlocks(toolResult(value));
  if (blocks.length !== 1 || blocks[0].kind !== "text") return undefined;

  const source = blocks[0].text;
  if (READ_IMAGE_NOTE.test(source)) return undefined;
  const offset = readOffset(value);
  const startLine = offset.state === "absent" ? 1 : offset.state === "valid" ? offset.line : undefined;

  let text = source;
  let notice: string | undefined;
  let noticeRange: { start?: number; end?: number; nextOffset: number } | undefined;
  const continuation = CONTINUATION_NOTICE.exec(source);
  if (continuation) {
    text = source.slice(0, continuation.index);
    notice = continuation[1];
    const noticeStart = positiveInteger(continuation[2]);
    const noticeEnd = positiveInteger(continuation[3]);
    const total = positiveInteger(continuation[4]);
    const remaining = positiveInteger(continuation[5]);
    const nextOffset = positiveInteger(continuation[6]);
    const showingLines = continuation[2] !== undefined;
    if (showingLines && noticeStart !== undefined && noticeEnd !== undefined && total !== undefined && nextOffset !== undefined && total >= noticeEnd && noticeEnd >= noticeStart && nextOffset === noticeEnd + 1) {
      noticeRange = { start: noticeStart, end: noticeEnd, nextOffset };
    } else if (!showingLines && remaining !== undefined && nextOffset !== undefined) {
      noticeRange = { nextOffset };
    }
  } else if (BYTE_LIMIT_NOTICE.test(source)) {
    // 整段只有提示，没有可编号的文件正文。
    text = "";
    notice = source;
  }

  const lines = countTextLines(text);
  const span = lines - 1;
  let endLine = startLine === undefined || lines === 0 || span > Number.MAX_SAFE_INTEGER - startLine ? undefined : startLine + span;
  // 续读 offset 只在能和原正文对上时用来补回被空行切开的前导换行；否则保持保守。
  if (noticeRange !== undefined && startLine !== undefined && text !== "") {
    const expectedEnd = noticeRange.nextOffset - 1;
    const expectedCount = noticeRange.nextOffset - startLine;
    const rawLines = text.split("\n").length;
    const startMatches = noticeRange.start === undefined || noticeRange.start === startLine;
    const endMatches = noticeRange.end === undefined || noticeRange.end === expectedEnd;
    if (expectedCount >= 1 && rawLines === expectedCount && startMatches && endMatches && Number.isSafeInteger(expectedEnd)) {
      endLine = expectedEnd;
    }
  }
  const range = startLine !== undefined && endLine !== undefined ? { startLine, endLine } : {};
  const limited = "limited" in value && value.limited === true;
  return {
    text,
    ...range,
    ...(notice === undefined ? {} : { notice }),
    partial: startLine !== 1 || notice !== undefined || toolWasTruncated(value) || limited,
  };
}

/** 只接受 write 请求里的 content 原文（包括空字符串）；其他工具或类型不猜。 */
export function writeToolContent(value: ToolValue): string | undefined {
  if (toolAction(value).kind !== "write") return undefined;
  const args = toolInput(value);
  if (!isRecord(args)) return undefined;
  return typeof args.content === "string" ? args.content : undefined;
}

/** 结果正文只在 edit／write 且整块精确等于内置成功回执时隐藏，其余真实数据原样保留。 */
export function readerResultBlocks(value: ToolValue): ToolContentBlock[] {
  const kind = toolAction(value).kind;
  const receipt = kind === "edit" ? EDIT_SUCCESS_RECEIPT : kind === "write" ? WRITE_SUCCESS_RECEIPT : undefined;
  const blocks = toolContentBlocks(value);
  if (receipt === undefined) return blocks;
  return blocks.filter((block) => block.kind !== "text" || !receipt.test(block.text));
}
