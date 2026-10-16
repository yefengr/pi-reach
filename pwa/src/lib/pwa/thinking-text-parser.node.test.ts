import { expect, test } from "vitest";
import { ThinkingTextParser } from "./thinking-text-parser";

function baseline(text: string) {
  const titles = [...text.matchAll(/^[ \t]*\*\*([^*\n]+?)\*\*[ \t]*$/gm)].map(match => match[1]!.trim()).filter(Boolean);
  const line = text.split("\n").map(value => value.trim()).find(Boolean);
  const summary = line?.replace(/\s+/g, " ");
  const summaryIsHeadingCandidate = summary !== undefined && /^\*(?:\*(?:[^*]+(?:\*{1,2})?)?)?$/.test(summary);
  return { firstTitle: titles[0], latestTitle: titles.at(-1), summary, summaryIsHeadingCandidate, empty: !text.trim() };
}

test.each([
  "**First**\nbody\n**Last**", "**Title**  x\n**Next**", "**   **\n**Valid**", "\n \t\n  检查　 工具\t分组 \r\n正文",
  "**Unfinished", "An inline **bold** word.", "\t **Indent** \t\r\nrest", "\u00a0**not indented**",
  "**检查**：接着说明", "**检查** 接着说明", "\n\t\n\u00a0**检查\t　内容**\t 接着说明",
  "*\t*", "** \t**", "***", "**未闭合\n正文**", "**完整**\n正文***", "**\t\r\u2028正文*\t*",
  "**Across\rline**\n**Later**", "**Across\u2028line**\nrest", "**A**\r**B**", "**A**\u2029**B**",
  "** \r **\n**Next**", "**A\r**B**", "***Bad***\n**Good**", "**Title**\r\n", "\n \t\r\n", "😀\tfoo\nbar",
])("matches baseline at every UTF-16 boundary: %j", text => {
  const parser = new ThinkingTextParser();
  const epoch = {};
  for (let length = 0; length <= text.length; length++) expect(parser.read(text.slice(0, length), epoch)).toEqual(baseline(text.slice(0, length)));
});

test("distinguishes incomplete bold headings from inline bold summaries while appending", () => {
  const parser = new ThinkingTextParser();
  const epoch = {};
  for (const text of ["*", "**", "**检查*", "**检查**"]) {
    expect(parser.read(text, epoch).summaryIsHeadingCandidate).toBe(true);
  }
  expect(parser.read("**检查**：说明", epoch)).toMatchObject({
    summary: "**检查**：说明", summaryIsHeadingCandidate: false, firstTitle: undefined, latestTitle: undefined,
  });
  const frozen = "**检查**：说明\n";
  const longBody = "**后续未闭合".repeat(1000);
  expect(parser.read(frozen, epoch).summaryIsHeadingCandidate).toBe(false);
  expect(parser.read(frozen + longBody, epoch)).toMatchObject({ summary: "**检查**：说明", summaryIsHeadingCandidate: false });
  expect(parser.scannedCharacters).toBe(frozen.length + longBody.length);
});

test("freezes incomplete first-line candidates and resets them on replacement", () => {
  const parser = new ThinkingTextParser();
  const epoch = {};
  expect(parser.read("\n\t\n**未闭合\n正文**", epoch)).toMatchObject({ summary: "**未闭合", summaryIsHeadingCandidate: true });
  expect(parser.read("**完整**\n正文***", {})).toMatchObject({ summaryIsHeadingCandidate: true, latestTitle: "完整" });
  expect(parser.read("**检查** 接着说明")).toMatchObject({ summary: "**检查** 接着说明", summaryIsHeadingCandidate: false });
  expect(parser.read("\n\t**检查\u00a0\t内容**\t：说明")).toMatchObject({ summary: "**检查 内容** ：说明", summaryIsHeadingCandidate: false });
  expect(parser.read(" \t\n").summaryIsHeadingCandidate).toBe(false);
});

test.each(["x".repeat(4000), `\n \t\n${"Reasoning.\n".repeat(400)}`, `**First**\n${"x".repeat(4000)}\n**Last**`])("scans only newly displayed UTF-16 characters, including long unterminated lines", text => {
  const parser = new ThinkingTextParser();
  const epoch = {};
  for (let length = 0; length <= text.length; length += 17) {
    parser.read(text.slice(0, length), epoch);
    parser.read(text.slice(0, length), epoch);
  }
  expect(parser.read(text, epoch)).toEqual(baseline(text));
  expect(parser.scannedCharacters).toBe(text.length);
});

test("matches the regex and summary oracle for deterministic mixed-boundary inputs", () => {
  const alphabet = ["*", "*", "A", "中", " ", "\t", "\n", "\r", "\u2028", "\u2029", "\u00a0", "\ufeff", "\ud83d", "\ude00"];
  let seed = 17;
  for (let sample = 0; sample < 1200; sample++) {
    const parser = new ThinkingTextParser();
    const epoch = {};
    let text = sample % 2 === 0 ? "**Title" : "";
    for (let index = 0; index < 48; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += alphabet[seed % alphabet.length]!;
      expect(parser.read(text, epoch)).toEqual(baseline(text));
    }
    expect(parser.scannedCharacters).toBe(text.length);
  }
});

test("formal takeover rebuilds once even without a trusted streaming epoch", () => {
  const parser = new ThinkingTextParser();
  const text = "**First**\nbody\n**Latest**";
  parser.read(text, undefined, true);
  expect(parser.read(text, undefined, false).firstTitle).toBe("First");
  expect(parser.scannedCharacters).toBe(text.length * 2);
  parser.read(text, undefined, false);
  expect(parser.scannedCharacters).toBe(text.length * 2);
});

test("rebuilds on replacement, length rollback and loss of trusted epoch", () => {
  const parser = new ThinkingTextParser();
  const epoch = {};
  for (const [text, token] of [["**Old**", epoch], ["**New**", {}], ["x", epoch], ["**Other**", undefined], ["**First**", undefined]] as const) {
    expect(parser.read(text, token)).toEqual(baseline(text));
  }
  const before = parser.scannedCharacters;
  parser.read("**First**");
  expect(parser.scannedCharacters).toBe(before);
});
