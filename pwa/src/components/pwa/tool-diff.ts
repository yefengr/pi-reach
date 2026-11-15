import { isRecord, reliableToolDiff, toolAction, toolResult, type ToolValue } from "./tool-presentation";

export type DiffRow =
  | { kind: "line"; sign: " " | "+" | "-"; text: string; oldLine?: number; newLine?: number }
  | { kind: "omission" };

export type ToolDiffView = {
  text: string;
  rows: DiffRow[];
  added: number;
  removed: number;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NO_NEWLINE = /^\\ No newline at end of file$/;
// Pi 自有 diff：符号 + 单侧行号 + 空格 + 原文，省略行为填充空白后的「...」。
const NATIVE_LINE = /^([ +-])\s*(\d+) (.*)$/;

/**
 * 只收集真实结果里的差异候选，绝不读取请求参数。
 * 优先统一 patch，其次 details.diff／result.diff／可识别的返回文本。
 */
function diffCandidates(value: ToolValue): string[] {
  const result = toolResult(value);
  const candidates: string[] = [];
  const details = isRecord(result) && isRecord(result.details) ? result.details : undefined;
  if (typeof details?.patch === "string" && details.patch.trim()) candidates.push(details.patch);
  if (typeof details?.diff === "string" && details.diff.trim()) candidates.push(details.diff);
  if (isRecord(result) && typeof result.diff === "string" && result.diff.trim()) candidates.push(result.diff);
  const recognized = reliableToolDiff(value);
  if (recognized !== undefined && !candidates.includes(recognized)) candidates.push(recognized);
  return candidates;
}

/**
 * 统一 diff 解析：只在 hunk 内把 `+`／`-` 当作增删行，因此 hunk 外以 `---`／`+++`
 * 开头的文件头被跳过，而 hunk 里文本恰好以 `++`／`--` 开头的真实代码行不会被误判。
 * hunk 按声明的行数收尾；任一损坏 hunk 都令整份解析失败，不推算虚假位置或总计。
 * 边界按一次 Edit 对应单文件的实际契约收窄：第一个 hunk 前只允许一对 `---`／`+++`
 * 文件头（可省略），之后只允许合法下一 hunk、精确的 No newline 标记或单个末尾空行；
 * 其他元信息、文件头与正文一律拒绝，不扩展为通用 Git patch 解析器。
 */
function parseStandardDiff(source: string): DiffRow[] | undefined {
  const lines = source.split("\n");
  const rows: DiffRow[] = [];
  let previous: { oldEnd: number; newEnd: number } | undefined;
  let index = 0;
  let sawHunk = false;
  let headersSeen = false;
  let oldHeaderPending = false;
  while (index < lines.length) {
    const line = lines[index];
    const header = HUNK_HEADER.exec(line);
    if (!sawHunk) {
      if (line.startsWith("--- ")) {
        if (headersSeen || oldHeaderPending) return undefined;
        oldHeaderPending = true;
        index += 1;
        continue;
      }
      if (line.startsWith("+++ ")) {
        if (!oldHeaderPending) return undefined;
        oldHeaderPending = false;
        headersSeen = true;
        index += 1;
        continue;
      }
      if (!header || oldHeaderPending) return undefined;
    } else if (!header) {
      const trailingBlank = line === "" && index === lines.length - 1;
      if (!trailingBlank && !NO_NEWLINE.test(line)) return undefined;
      index += 1;
      continue;
    }
    sawHunk = true;
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    if (!Number.isSafeInteger(oldCount) || oldCount < 0 || !Number.isSafeInteger(newCount) || newCount < 0) return undefined;
    // 统一 diff 的零起点只属于行数为 0 的一侧；有内容的一侧必须从正整数行开始。
    if (!Number.isSafeInteger(oldStart) || oldStart < 0 || (oldCount > 0 && oldStart === 0)) return undefined;
    if (!Number.isSafeInteger(newStart) || newStart < 0 || (newCount > 0 && newStart === 0)) return undefined;
    const hunkRows: DiffRow[] = [];
    let oldUsed = 0;
    let newUsed = 0;
    index += 1;
    while (index < lines.length && (oldUsed < oldCount || newUsed < newCount)) {
      const line = lines[index];
      // 只认 GNU 精确的 No newline 标记；其他反斜线行属于损坏正文。
      if (NO_NEWLINE.test(line)) {
        index += 1;
        continue;
      }
      const sign = line[0];
      if (line === "" || (sign !== " " && sign !== "+" && sign !== "-")) break;
      if (sign === "+") {
        if (newUsed >= newCount) break;
        const newLine = newStart + newUsed;
        if (!Number.isSafeInteger(newLine) || newLine <= 0) return undefined;
        hunkRows.push({ kind: "line", sign: "+", text: line.slice(1), newLine });
        newUsed += 1;
      } else if (sign === "-") {
        if (oldUsed >= oldCount) break;
        const oldLine = oldStart + oldUsed;
        if (!Number.isSafeInteger(oldLine) || oldLine <= 0) return undefined;
        hunkRows.push({ kind: "line", sign: "-", text: line.slice(1), oldLine });
        oldUsed += 1;
      } else {
        if (oldUsed >= oldCount || newUsed >= newCount) break;
        const oldLine = oldStart + oldUsed;
        const newLine = newStart + newUsed;
        if (!Number.isSafeInteger(oldLine) || oldLine <= 0 || !Number.isSafeInteger(newLine) || newLine <= 0) return undefined;
        hunkRows.push({ kind: "line", sign: " ", text: line.slice(1), oldLine, newLine });
        oldUsed += 1;
        newUsed += 1;
      }
      index += 1;
    }
    // 局部丢弃会让增删总数和仍在显示的行号范围失真，整份拒绝后交给 native 解析器。
    if (oldUsed !== oldCount || newUsed !== newCount || hunkRows.length === 0) return undefined;
    const oldEnd = oldStart + oldCount - 1;
    const newEnd = newStart + newCount - 1;
    const contiguous = previous !== undefined && oldStart === previous.oldEnd + 1 && newStart === previous.newEnd + 1;
    if (previous !== undefined && !contiguous) rows.push({ kind: "omission" });
    rows.push(...hunkRows);
    previous = { oldEnd, newEnd };
  }
  return rows.some((row) => row.kind === "line") ? rows : undefined;
}

/**
 * Pi 自有 diff 每行只有单侧行号：新增只可靠对应新行，删除只可靠对应旧行。
 * 上下文行按 SDK 输出的是旧行号，且旧／新偏移可能因增删数量不同而不等，
 * 因此不能把同一个数字同时填进两侧。省略行转成删除标记。
 */
function parseNativeDiff(source: string): DiffRow[] | undefined {
  const lines = source.split("\n");
  const rows: DiffRow[] = [];
  let sawLine = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "" && index === lines.length - 1) continue;
    if (/^ +\.\.\.$/.test(line)) {
      if (rows[rows.length - 1]?.kind !== "omission") rows.push({ kind: "omission" });
      continue;
    }
    const match = NATIVE_LINE.exec(line);
    if (!match) return undefined;
    const sign = match[1];
    const lineNumber = Number(match[2]);
    if (!Number.isSafeInteger(lineNumber) || lineNumber <= 0) return undefined;
    sawLine = true;
    if (sign === "+") rows.push({ kind: "line", sign: "+", text: match[3], newLine: lineNumber });
    else if (sign === "-") rows.push({ kind: "line", sign: "-", text: match[3], oldLine: lineNumber });
    else rows.push({ kind: "line", sign: " ", text: match[3], oldLine: lineNumber });
  }
  return sawLine ? rows : undefined;
}

function countRows(rows: readonly DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind !== "line") continue;
    if (row.sign === "+") added += 1;
    else if (row.sign === "-") removed += 1;
  }
  return { added, removed };
}

/** 优先展示真实统一 patch，缺失时退回 Pi 自有 diff；都不可识别时不伪造差异。 */
export function toolDiffView(value: ToolValue): ToolDiffView | undefined {
  if (toolAction(value).kind !== "edit") return undefined;
  for (const source of diffCandidates(value)) {
    const rows = parseStandardDiff(source) ?? parseNativeDiff(source);
    if (rows === undefined) continue;
    return { text: source, rows, ...countRows(rows) };
  }
  return undefined;
}
