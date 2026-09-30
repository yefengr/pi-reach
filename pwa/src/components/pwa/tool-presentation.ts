import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import { getMessages } from "@/lib/i18n";

export type ToolValue = Extract<TimelineEvent, { kind: "tool" }> | Extract<TimelinePartial, { kind: "tool" }>;
export type ToolStatus = "running" | "complete" | "error" | "interrupted" | "unknown";
export type ToolKind = "read" | "command" | "search" | "edit" | "write" | "generic";
export type ToolIconKind = "file" | "terminal" | "search" | "edit" | "write" | "tool";

type RecordValue = Record<string, unknown>;

export type ToolAction = {
  kind: ToolKind;
  icon: ToolIconKind;
  label: string;
  detail: string;
};

export type ToolOutputBlock =
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string; data?: string; omitted: boolean; byteLength?: number }
  | { kind: "json"; value: unknown };

export type SearchMatch = {
  path: string;
  text: string;
  line?: number;
};

const PATH_KEYS = ["path", "file_path", "filePath"] as const;
const COMMAND_KEYS = ["command", "cmd"] as const;
const QUERY_KEYS = ["pattern", "query", "search", "glob"] as const;
const DIFF_LINE = /^[+-](?![+-])/m;
const DIFF_HEADER = /^(?:diff --git |--- .+\n\+\+\+ )/m;

export function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolIdentity(value: ToolValue): string {
  return JSON.stringify([value.session_id, value.leaf_id, value.group_id, value.tool_call_id]);
}

export function isToolPartial(value: ToolValue): value is Extract<TimelinePartial, { kind: "tool" }> {
  return "partial_id" in value;
}

export function toolStatus(value: ToolValue, override?: ToolStatus): ToolStatus {
  if (override !== undefined) return override;
  return isToolPartial(value) ? "running" : value.status;
}

function nameParts(name: string): readonly string[] {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasName(name: string, ...candidates: readonly (readonly string[])[]): boolean {
  const parts = nameParts(name);
  return candidates.some((candidate) => candidate.length === parts.length && candidate.every((part, index) => parts[index] === part));
}

function stringField(args: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(args)) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function genericLabel(tool: string): string {
  return getMessages().tools.useTool(tool.trim());
}

/**
 * 专用视图仅在工具名和必要参数同时明确时启用，避免把同名但不同语义的工具误分类。
 */
export function toolAction(value: ToolValue): ToolAction {
  const { tool, args } = value;
  const path = stringField(args, PATH_KEYS);
  const command = stringField(args, COMMAND_KEYS);
  const query = stringField(args, QUERY_KEYS);
  const t = getMessages().tools;

  if (hasName(tool, ["read"], ["read", "file"]) && path) {
    return { kind: "read", icon: "file", label: t.readFile, detail: path };
  }
  if (hasName(tool, ["bash"], ["shell"], ["exec"], ["execute"], ["run", "command"]) && command) {
    return { kind: "command", icon: "terminal", label: t.runCommand, detail: command };
  }
  if (hasName(tool, ["grep"], ["rg"], ["search"], ["find"], ["glob"]) && query) {
    return { kind: "search", icon: "search", label: t.searchQuery, detail: query };
  }
  if (hasName(tool, ["edit"], ["edit", "file"], ["patch"], ["apply", "patch"]) && path) {
    return { kind: "edit", icon: "edit", label: t.editFile, detail: path };
  }
  if (hasName(tool, ["write"], ["write", "file"], ["create", "file"]) && path) {
    return { kind: "write", icon: "write", label: t.writeFile, detail: path };
  }
  return { kind: "generic", icon: "tool", label: genericLabel(tool), detail: parameterSummary(args) };
}

/** 折叠行只概括真实参数，结果和预览留给展开内容；展开前后标题保持一致。 */
export function toolHeaderSummary(value: ToolValue): string {
  const action = toolAction(value);
  const detail = action.detail.replace(/[\r\n\t]+/g, " ").trim();
  if (action.kind !== "read" || !isRecord(value.args)) return detail;

  const offset = readLineOffset(value);
  const limit = value.args.limit;
  if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0) {
    const start = offset ?? 1;
    const end = start + (limit - 1);
    if (Number.isSafeInteger(end)) return `${detail} · L${start}–${end}`;
  }
  return offset === undefined ? detail : `${detail} · L${offset}+`;
}

function parameterSummary(args: unknown): string {
  if (typeof args === "string") return previewText(args, 120, 1);
  if (!isRecord(args)) return "";
  const keys = Object.keys(args).slice(0, 3);
  return keys.join(" · ");
}

export function toolInput(value: ToolValue): unknown {
  return "args" in value ? value.args : undefined;
}

export function toolResult(value: ToolValue): unknown {
  if (isToolPartial(value)) return value.blocks ?? value.delta;
  return "result" in value ? value.result : undefined;
}

export function toolError(value: ToolValue): string | undefined {
  return !isToolPartial(value) && value.status === "error" ? value.error : undefined;
}

export function toolWasTruncated(value: ToolValue): boolean {
  return !isToolPartial(value) && value.truncated;
}

export function safeJsonText(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (isRecord(item) && item.type === "image" && typeof item.data === "string") {
        return { ...item, data: "[image data omitted; rendered in Output]" };
      }
      return item;
    }, 2);
    return text ?? "undefined";
  } catch {
    return "[Unable to serialize structured data]";
  }
}

export function previewText(text: string, maximumCharacters = 480, maximumLines = 6): string {
  const lines = text.split("\n");
  const limitedLines = lines.slice(0, maximumLines);
  let preview = limitedLines.join("\n");
  const needsLineMarker = lines.length > maximumLines;
  const needsCharacterMarker = preview.length > maximumCharacters;
  if (needsCharacterMarker) preview = safeSlice(preview, maximumCharacters);
  return needsLineMarker || needsCharacterMarker ? `${preview}\n…` : preview;
}

function safeSlice(text: string, maximumCharacters: number): string {
  if (text.length <= maximumCharacters) return text;
  let end = Math.max(0, maximumCharacters);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
  return text.slice(0, end);
}

export function inputPreview(value: ToolValue): string {
  const input = toolInput(value);
  return previewText(typeof input === "string" ? input : safeJsonText(input));
}

export function outputPreview(value: ToolValue): string {
  const blocks = toolOutputBlocks(toolResult(value));
  const text = blocks.map((block) => {
    if (block.kind === "text") return block.text;
    if (block.kind === "image") return `[image${block.mime ? `: ${block.mime}` : ""}]`;
    return safeJsonText(block.value);
  }).join("\n");
  return previewText(text || getMessages().tools.noTextOutput);
}

export function toolOutputBlocks(source: unknown): readonly ToolOutputBlock[] {
  const content = isRecord(source) && Array.isArray(source.content) ? source.content : source;
  if (content === undefined) return [];
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (Array.isArray(content)) return content.map(outputBlock);
  return [outputBlock(content)];
}

function outputBlock(value: unknown): ToolOutputBlock {
  if (isRecord(value) && (value.type === "text" || value.type === "thinking") && typeof value.text === "string") {
    return { kind: "text", text: value.text };
  }
  if (isRecord(value) && value.type === "image") {
    const mime = typeof value.mimeType === "string" ? value.mimeType : typeof value.mime_type === "string" ? value.mime_type : "";
    const data = typeof value.data === "string" ? value.data : undefined;
    const byteLength = typeof value.byte_length === "number" ? value.byte_length : undefined;
    return { kind: "image", mime, data, omitted: value.omitted === true || data === undefined, byteLength };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return { kind: "text", text: String(value) };
  return { kind: "json", value };
}

/** 仅从真实结果提取 diff，绝不读取输入参数中的 diff 或 content。 */
export function reliableToolDiff(value: ToolValue): string | undefined {
  const result = toolResult(value);
  if (isRecord(result)) {
    const diff = typeof result.diff === "string" ? result.diff : isRecord(result.details) ? result.details.diff : undefined;
    if (typeof diff === "string" && diff.trim()) return diff;
  }
  return toolOutputBlocks(result).find((block): block is Extract<ToolOutputBlock, { kind: "text" }> => block.kind === "text" && DIFF_HEADER.test(block.text) && DIFF_LINE.test(block.text))?.text;
}

export function readLineOffset(value: ToolValue): number | undefined {
  const args = toolInput(value);
  if (!isRecord(args)) return undefined;
  for (const key of ["offset", "start_line", "startLine"]) {
    const valueAtKey = args[key];
    if (typeof valueAtKey === "number" && Number.isSafeInteger(valueAtKey) && valueAtKey >= 0) return valueAtKey;
  }
  return undefined;
}

export function searchMatches(value: ToolValue): readonly SearchMatch[] | undefined {
  const result = toolResult(value);
  const source = isRecord(result) && Array.isArray(result.matches) ? result.matches : result;
  if (!Array.isArray(source)) return undefined;
  const matches: SearchMatch[] = [];
  for (const item of source) {
    if (!isRecord(item)) return undefined;
    const path = stringField(item, ["path", "file", "file_path", "filePath"]);
    const text = stringField(item, ["text", "match", "line_text", "lineText"]);
    const lineCandidate = item.line ?? item.line_number ?? item.lineNumber;
    const line = typeof lineCandidate === "number" && Number.isSafeInteger(lineCandidate) && lineCandidate >= 0 ? lineCandidate : undefined;
    if (!path || text === undefined) return undefined;
    matches.push({ path, text, line });
  }
  return matches;
}

export const TOOL_HEADER_MAX_CHARACTERS = 240;
export const TOOL_HEADER_MAX_LINES = 4;
export const TOOL_INLINE_MAX_LINES = 12;
export const TOOL_INLINE_MAX_CHARACTERS = 2_400;
export const TOOL_INLINE_MAX_BLOCKS = 8;
export const TOOL_INLINE_IMAGE_MAX_HEIGHT = 240;
export const TOOL_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

type ContentStyle = "plain" | "code" | "terminal" | "diff" | "error" | "notice" | "json";
export type ToolContentBlock =
  | { kind: "text"; text: string; style: ContentStyle; label?: string; path?: string }
  | Extract<ToolOutputBlock, { kind: "image" }>;

/** 标题独立限长并保持 Unicode 完整；正文预算与 Reader 全文不受影响。 */
export function toolInlineText(text: string): string {
  return previewText(text, TOOL_HEADER_MAX_CHARACTERS, TOOL_HEADER_MAX_LINES);
}

/** 命令类工具的完整调用；作为展开输出块的第一行回显，参数仍只走专用视图。 */
export function toolCommandLead(value: ToolValue): string | undefined {
  const action = toolAction(value);
  return action.kind === "command" ? `$ ${action.detail}` : undefined;
}

/** 完整调用上下文以原始换行显示；大正文在同一内容流内单独呈现。 */
export function toolCallText(value: ToolValue): string {
  const action = toolAction(value);
  const heading = toolCommandLead(value) ?? toolHeaderSummary(value);
  const args = toolInput(value);
  if (action.kind === "generic") return `${value.tool}${heading ? ` ${heading}` : ""}`;
  if (!isRecord(args)) return heading;
  const consumed = new Set<string>(action.kind === "command" ? COMMAND_KEYS : action.kind === "search" ? QUERY_KEYS : PATH_KEYS);
  if (action.kind === "write") consumed.add("content");
  const requested = action.kind === "edit" ? requestedToolDiff(value) : undefined;
  if (requested !== undefined) {
    for (const key of ["edits", "oldText", "newText"]) consumed.add(key);
  }
  const extra = Object.entries(args).filter(([key]) => !consumed.has(key)).map(([key, item]) => `${key}: ${typeof item === "string" ? item : safeJsonText(item)}`);
  // 已返回 diff 时，正文优先展示真实修改；完整调用仍保留原始请求供对照。
  if (requested !== undefined && reliableToolDiff(value)) extra.push(`${getMessages().tools.requestedChanges}\n${requested}`);
  return [heading, ...extra].join("\n");
}

function requestedToolDiff(value: ToolValue): string | undefined {
  const args = toolInput(value);
  if (!isRecord(args)) return undefined;
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  if (edits.length === 0 || !edits.every((edit) => isRecord(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string")) return undefined;
  return edits.map((edit) => {
    const replacement = edit as { oldText: string; newText: string };
    return [replacement.oldText === "" ? "" : replacement.oldText.split("\n").map((line) => `-${line}`).join("\n"), replacement.newText === "" ? "" : replacement.newText.split("\n").map((line) => `+${line}`).join("\n")].filter(Boolean).join("\n");
  }).join("\n\n");
}

/** 真实结果优先保留；请求 diff 不代表执行成功，也不覆盖失败和中断输出。 */
export function toolContentBlocks(value: ToolValue): ToolContentBlock[] {
  const action = toolAction(value);
  const output = toolResult(value);
  const error = toolError(value);
  const blocks: ToolContentBlock[] = [];
  const resultBlocks = toolOutputBlocks(output);
  const errorInResult = error !== undefined && resultBlocks.some((block) => block.kind === "text" && block.text.includes(error));
  if (error && !errorInResult) blocks.push({ kind: "text", text: error, style: "error", label: getMessages().tools.toolError });
  if (toolStatus(value) === "interrupted") blocks.push({ kind: "text", text: getMessages().tools.interruptedNotice, style: "notice" });
  const diff = action.kind === "edit" ? reliableToolDiff(value) : undefined;
  const requested = action.kind === "edit" && !diff ? requestedToolDiff(value) : undefined;
  const matches = action.kind === "search" ? searchMatches(value) : undefined;
  if (action.kind === "write" && !error && toolStatus(value) !== "interrupted" && isRecord(value.args) && typeof value.args.content === "string") {
    blocks.push({ kind: "text", text: value.args.content, style: "code", path: action.detail });
  }
  if (matches !== undefined) {
    blocks.push({ kind: "text", text: matches.length ? matches.map((match) => `${match.path}${match.line === undefined ? "" : `:${match.line}`}\n${match.text}`).join("\n") : getMessages().tools.noMatches, style: "plain", label: getMessages().tools.searchResults });
  } else {
    for (const block of resultBlocks) {
      if (block.kind === "image") { blocks.push(block); continue; }
      if (block.kind === "text") {
        if (diff === block.text) continue;
        blocks.push({ kind: "text", text: block.text, style: error && block.text.includes(error) ? "error" : action.kind === "read" ? "code" : action.kind === "command" ? "terminal" : "plain", path: action.kind === "read" ? action.detail : undefined });
        continue;
      }
      if (action.kind === "generic") {
        blocks.push({ kind: "text", text: safeJsonText(block.value), style: "json" });
        continue;
      }
      // 参数不进入通用 JSON 面板；真实结果中尚未被专用视图消费的字段仍须可读。
      const messages = isRecord(block.value) ? [block.value.message, block.value.error, block.value.text].filter((item): item is string => typeof item === "string" && item !== error) : [];
      for (const text of messages) blocks.push({ kind: "text", text, style: "plain" });
      const remaining = remainingToolResult(block.value, diff);
      if (remaining !== undefined) blocks.push({ kind: "text", text: safeJsonText(remaining), style: "json" });
    }
  }
  if (diff) blocks.push({ kind: "text", text: diff, style: "diff", label: getMessages().tools.returnedDiff });
  if (requested !== undefined) blocks.push({ kind: "text", text: requested, style: "diff", label: getMessages().tools.requestedChanges });
  if (action.kind === "write" && (error || toolStatus(value) === "interrupted") && isRecord(value.args) && typeof value.args.content === "string") {
    blocks.push({ kind: "text", text: value.args.content, style: "code", path: action.detail });
  }
  if (action.kind === "generic" && toolInput(value) !== undefined) blocks.unshift({ kind: "text", text: typeof value.args === "string" ? value.args : safeJsonText(value.args), style: "json", label: getMessages().tools.parameters });
  if (!blocks.length) blocks.push({ kind: "text", text: output === undefined ? getMessages().tools.noOutputYet : getMessages().tools.noTextOutput, style: "notice" });
  return blocks;
}

function remainingToolResult(value: unknown, diff: string | undefined): unknown {
  if (!isRecord(value)) return value;
  const remaining = { ...value };
  for (const key of ["message", "error", "text"]) {
    if (typeof remaining[key] === "string") delete remaining[key];
  }
  if (diff !== undefined && remaining.diff === diff) delete remaining.diff;
  if (diff !== undefined && isRecord(remaining.details) && remaining.details.diff === diff) {
    const details = { ...remaining.details };
    delete details.diff;
    if (Object.keys(details).length) remaining.details = details;
    else delete remaining.details;
  }
  return Object.keys(remaining).length ? remaining : undefined;
}

/** 内联预算跨块累计，避免许多小块绕过上限；展开预览首行回显命令调用。 */
export function toolContentView(value: ToolValue, preview = false): { blocks: ToolContentBlock[]; clipped: boolean } {
  const source = toolContentBlocks(value);
  if (!preview) return { blocks: source, clipped: false };
  const blocks: ToolContentBlock[] = [];
  let characters = TOOL_INLINE_MAX_CHARACTERS;
  let lines = TOOL_INLINE_MAX_LINES;
  let clipped = false;
  // 命令回显沿用标题限长，长命令不能占满预览行数、把真实结果挤出首屏。
  const command = toolCommandLead(value);
  if (command !== undefined) {
    const text = toolInlineText(command);
    blocks.push({ kind: "text", text, style: "terminal" });
    characters -= text.length;
    lines -= text.split("\n").length;
    if (text !== command) clipped = true;
  }
  for (const block of source) {
    if (blocks.length >= TOOL_INLINE_MAX_BLOCKS || (block.kind === "text" && (characters <= 0 || lines <= 0))) { clipped = true; break; }
    if (block.kind === "image") { blocks.push(block); continue; }
    const text = safeSlice(block.text.split("\n", lines).join("\n"), characters);
    blocks.push({ ...block, text });
    characters -= text.length;
    lines -= text.split("\n").length;
    if (text !== block.text) clipped = true;
  }
  return { blocks, clipped };
}

/** 完整输出中文本块的总行数，用于「查看全部（共 N 行）」。 */
export function toolLineCount(value: ToolValue): number {
  return toolContentBlocks(value).reduce((total, block) => total + (block.kind === "text" && block.text ? block.text.split("\n").length : 0), 0);
}

/** 静态预算已省略正文或完整调用时需要详情；真实布局溢出由 ToolPreview 处理。 */
export function toolHasOverflow(value: ToolValue): boolean {
  const view = toolContentView(value, true);
  const call = toolCallText(value);
  return view.clipped || toolInlineText(call) !== call || view.blocks.some((block) => block.kind === "image" && !block.omitted && Boolean(block.data) && TOOL_IMAGE_MIMES.has(block.mime));
}
