import { getMessages } from "@/lib/i18n";

// 数据库中保存的占位预览沿用英文原文；展示时按界面语言替换。
const STORED_FALLBACK_PREVIEW = "Saved conversation";
const CODE_TOKEN_PREFIX = "\u0000history-preview-code-";
const CODE_TOKEN_SUFFIX = "\u0000";

type FenceState = {
  character: "`" | "~";
  length: number;
  lines: string[];
};

function codeToken(codes: string[], value: string): string {
  const token = `${CODE_TOKEN_PREFIX}${codes.length}${CODE_TOKEN_SUFFIX}`;
  codes.push(value);
  return token;
}

function isClosingFence(line: string, fence: FenceState): boolean {
  const marker = line.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/)?.[1];
  return marker !== undefined && marker[0] === fence.character && marker.length >= fence.length;
}

function protectFencedCode(value: string, codes: string[]): string {
  const lines = value.split(/\r?\n/);
  const output: string[] = [];
  let fence: FenceState | null = null;

  for (const line of lines) {
    if (fence !== null) {
      if (isClosingFence(line, fence)) {
        output.push(codeToken(codes, fence.lines.join("\n")));
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }

    const opening = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/)?.[1];
    if (opening !== undefined) {
      fence = { character: opening[0] as "`" | "~", length: opening.length, lines: [] };
    } else {
      output.push(line);
    }
  }

  if (fence !== null) output.push(codeToken(codes, fence.lines.join("\n")));
  return output.join("\n");
}

function protectInlineCode(value: string, codes: string[]): string {
  return value.replace(/(`+)([^\n]*?)\1/g, (_match, _ticks, content) => codeToken(codes, content));
}

function protectCode(value: string): { text: string; codes: string[] } {
  const codes: string[] = [];
  const fenced = protectFencedCode(value, codes);
  return { text: protectInlineCode(fenced, codes), codes };
}

function findClosingBracket(value: string, openingIndex: number): number {
  let depth = 0;
  for (let index = openingIndex; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") depth += 1;
    if (character === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findLinkDestinationEnd(value: string, openingIndex: number): number {
  let depth = 1;
  for (let index = openingIndex; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function replaceLinks(value: string): string {
  let output = "";
  let index = 0;

  while (index < value.length) {
    const isImage = value[index] === "!" && value[index + 1] === "[";
    const openingIndex = isImage || value[index] === "[" ? index + (isImage ? 1 : 0) : -1;
    if (openingIndex === -1) {
      output += value[index];
      index += 1;
      continue;
    }

    const closingIndex = findClosingBracket(value, openingIndex);
    if (closingIndex === -1 || value[closingIndex + 1] !== "(") {
      output += value[index];
      index += 1;
      continue;
    }

    const destinationEnd = findLinkDestinationEnd(value, closingIndex + 2);
    output += value.slice(openingIndex + 1, closingIndex);
    index = destinationEnd === -1 ? value.length : destinationEnd + 1;
  }

  return output;
}

const BLOCK_PREFIX_PATTERN = /^[ \t]{0,3}(?:(?:>[ \t]*)+|#{1,6}(?=[ \t]|$)[ \t]*|(?:[-+*]|\d+[.)])(?=[ \t])[ \t]*)/;

function stripBlockPrefixes(value: string): string {
  return value.split("\n").map((line) => {
    let current = line;
    for (let pass = 0; pass < 8; pass += 1) {
      const next = current.replace(BLOCK_PREFIX_PATTERN, "");
      if (next === current) break;
      current = next;
    }
    return current;
  }).join("\n");
}

const PAIRED_MARKER_PATTERNS = [
  /(^|[^*])\*{2}(?=\S)([\s\S]*?\S)\*{2}(?!\*)/g,
  /(^|[^A-Za-z0-9_])_{2}(?=\S)([\s\S]*?\S)_{2}(?![A-Za-z0-9_])/g,
  /(^|[^~])~~(?=\S)([\s\S]*?\S)~~(?!~)/g,
  /(^|[^*])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g,
  /(^|[^A-Za-z0-9_])_(?=\S)([\s\S]*?\S)_(?![A-Za-z0-9_])/g,
];

function stripPairedMarkers(value: string): string {
  let current = value;
  for (let pass = 0; pass < 8; pass += 1) {
    let next = current;
    for (const pattern of PAIRED_MARKER_PATTERNS) next = next.replace(pattern, "$1$2");
    if (next === current) return current;
    current = next;
  }
  return current;
}

function restoreCode(value: string, codes: readonly string[]): string {
  return value.replace(/\u0000history-preview-code-(\d+)\u0000/g, (_match, index) => codes[Number(index)] ?? "");
}

function containsMeaningfulText(value: string): boolean {
  return value.replace(/[\s*_~#\[\]()>!+\-`]/g, "").length > 0;
}

// 仅覆盖摘要需要的 Markdown 结构，不尝试实现完整 CommonMark 解析。
export function historyPreviewText(value: string): string {
  const protectedValue = protectCode(value);
  const cleaned = restoreCode(
    stripPairedMarkers(stripBlockPrefixes(replaceLinks(protectedValue.text))),
    protectedValue.codes,
  ).replace(/\s+/g, " ").trim();
  const hasCodeText = protectedValue.codes.some((code) => code.trim().length > 0);
  return cleaned && cleaned !== STORED_FALLBACK_PREVIEW && (containsMeaningfulText(cleaned) || hasCodeText) ? cleaned : getMessages().workspace.savedConversation;
}

export function historySessionTitle(value: { name?: string; preview: string }): string {
  const name = value.name?.trim();
  return name || historyPreviewText(value.preview);
}
