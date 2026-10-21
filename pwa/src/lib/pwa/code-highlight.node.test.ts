import { afterEach, describe, expect, test, vi } from "vitest";
import hljs from "highlight.js/lib/core";
import { highlightCode, languageForFence } from "./code-highlight";

const PREVIOUS_CHARACTER_LIMIT = 32_000;
const PREVIOUS_LINE_LIMIT = 2_000;
const MOCKED_HTML = '<span class="hljs-keyword">mocked</span>';

/** 旧实现的行数判断，仅作为本测试的等价 oracle。 */
function previousGuardRejects(text: string): boolean {
  return text.length > PREVIOUS_CHARACTER_LIMIT || text.split("\n", PREVIOUS_LINE_LIMIT + 1).length > PREVIOUS_LINE_LIMIT;
}

/** 只隔离 guard 之后的 highlight.js 调用，避免其内部实现干扰 split 计数。 */
function mockSuccessfulHighlight() {
  return vi.spyOn(hljs, "highlight").mockReturnValue({
    value: MOCKED_HTML,
    language: "javascript",
    relevance: 0,
    illegal: false,
  } as ReturnType<typeof hljs.highlight>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("highlightCode guard", () => {
  test("does not build a temporary line array", () => {
    const highlight = mockSuccessfulHighlight();
    // 原生 split 继续执行，只记录 guard 是否调用它，不用破坏行为制造假失败。
    const split = vi.spyOn(String.prototype, "split");
    const guarded = highlightCode("const answer = 42;", "javascript");
    const splitCalls = split.mock.calls.length;
    split.mockRestore();
    highlight.mockRestore();
    expect(guarded).toBe(MOCKED_HTML);
    expect(splitCalls).toBe(0);
  });

  test("undefined language returns before scanning the text", () => {
    const highlight = mockSuccessfulHighlight();
    const split = vi.spyOn(String.prototype, "split");
    const guarded = highlightCode(`${"x\n".repeat(PREVIOUS_LINE_LIMIT + 1)}x`, undefined);
    const highlightCalls = highlight.mock.calls.length;
    const splitCalls = split.mock.calls.length;
    split.mockRestore();
    highlight.mockRestore();
    expect(guarded).toBeUndefined();
    expect(highlightCalls).toBe(0);
    expect(splitCalls).toBe(0);
  });

  const guardCases: Array<{ name: string; text: string }> = [
    { name: "empty string", text: "" },
    { name: "single line", text: "const answer = 42;" },
    { name: "1999 LF stays at 2000 lines", text: `${"x\n".repeat(1999)}x` },
    { name: "2000 LF exceeds 2000 lines", text: `${"x\n".repeat(2000)}x` },
    { name: "trailing LF adds an empty line", text: `${"x\n".repeat(1999)}x\n` },
    { name: "1999 blank-line LF", text: "\n".repeat(1999) },
    { name: "2000 blank-line LF", text: "\n".repeat(2000) },
    { name: "CRLF counts its LF", text: `${"x\r\n".repeat(1999)}x` },
    { name: "2000 CRLF exceeds", text: `${"x\r\n".repeat(2000)}x` },
    { name: "lone CR is not a line break", text: "\r".repeat(4000) },
    { name: "lone CR inside short lines", text: "a\rb\r".repeat(500) },
    { name: "U+2028 is not a line break", text: "\u2028".repeat(3000) },
    { name: "U+2029 is not a line break", text: "\u2029".repeat(3000) },
    { name: "exactly 32000 UTF-16 units", text: "x".repeat(32000) },
    { name: "32001 UTF-16 units", text: "x".repeat(32001) },
    { name: "32000 units of astral emoji", text: "😀".repeat(16000) },
    { name: "32001 units with astral emoji", text: `${"😀".repeat(16000)}x` },
    { name: "2000 LF within the character limit", text: "a\n".repeat(2000) },
  ];

  test.each(guardCases)("matches the split oracle: $name", ({ text }) => {
    const highlight = mockSuccessfulHighlight();
    const rejected = previousGuardRejects(text);
    const guarded = highlightCode(text, "javascript");
    expect(highlight).toHaveBeenCalledTimes(rejected ? 0 : 1);
    expect(guarded).toBe(rejected ? undefined : MOCKED_HTML);
  });
});

describe("languageForFence", () => {
  test.each([
    ["JavaScript", "javascript"],
    ["  ts  ", "typescript"],
    ["TSX", "typescript"],
    ["node", "javascript"],
    ["shell", "bash"],
    ["svg", "xml"],
    ["YML", "yaml"],
    ["md", "markdown"],
    ["json", "json"],
  ])("normalizes %s to %s", (fence, expected) => {
    expect(languageForFence(fence)).toBe(expected);
  });

  test("unknown or empty fences stay unhighlighted", () => {
    expect(languageForFence(undefined)).toBeUndefined();
    expect(languageForFence("   ")).toBeUndefined();
    expect(languageForFence("not-a-language")).toBeUndefined();
  });

  test("alias fences reach the real highlighter", () => {
    expect(highlightCode("const answer = 42;", languageForFence("JS"))).toContain("hljs-");
  });
});

describe("real highlight.js output", () => {
  test("registered representatives stay highlighted", () => {
    const samples: Array<[string, string]> = [
      ["javascript", "const answer = 42;"],
      ["typescript", "const answer: number = 42;"],
      ["xml", '<root><item id="1" /></root>'],
      ["json", '{"answer": 42}'],
    ];
    for (const [language, code] of samples) {
      const highlighted = highlightCode(code, language);
      expect(highlighted, language).toBeTypeOf("string");
      expect(highlighted, language).toContain("hljs-");
    }
  });

  test("unicode text keeps its characters", () => {
    const highlighted = highlightCode('const 变量 = "😀";', "javascript");
    expect(highlighted).toBeDefined();
    expect(highlighted).toContain("变量");
    expect(highlighted).toContain("😀");
  });

  test("escapes markup instead of emitting active elements", () => {
    const xml = highlightCode("<script>alert(1)</script><img src=x>", "xml");
    expect(xml).toContain("&lt;");
    expect(xml).not.toMatch(/<(script|img)\b/i);

    const javascript = highlightCode('const html = "<iframe src=x></iframe>";', "javascript");
    expect(javascript).toContain("&lt;iframe");
    expect(javascript).not.toMatch(/<iframe\b/i);
  });

  test("passes ignoreIllegals for illegal syntax", () => {
    const highlight = vi.spyOn(hljs, "highlight");
    const highlighted = highlightCode("const = 1;", "javascript");
    expect(highlight).toHaveBeenCalledWith("const = 1;", { language: "javascript", ignoreIllegals: true });
    expect(highlighted).toBeTypeOf("string");
  });

  test("returns undefined when highlight.js throws", () => {
    vi.spyOn(hljs, "highlight").mockImplementation(() => {
      throw new Error("highlighter failure");
    });
    expect(highlightCode("const answer = 42;", "javascript")).toBeUndefined();
  });
});
