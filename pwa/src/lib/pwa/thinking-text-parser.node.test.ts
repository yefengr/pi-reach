import { expect, test } from "vitest";
import { ThinkingTextParser } from "./thinking-text-parser";

function baseline(text: string) {
  const titles = [...text.matchAll(/^[ \t]*\*\*([^*\n]+?)\*\*[ \t]*$/gm)].map(match => match[1]!.trim()).filter(Boolean);
  const line = text.split("\n").map(value => value.trim()).find(Boolean);
  return { firstTitle: titles[0], latestTitle: titles.at(-1), summary: line?.replace(/\s+/g, " "), empty: !text.trim() };
}

test.each([
  "**First**\nbody\n**Last**", "**Title**  x\n**Next**", "**   **\n**Valid**", "\n \t\n  检查　 工具\t分组 \r\n正文",
  "**Unfinished", "An inline **bold** word.", "\t **Indent** \t\r\nrest", "\u00a0**not indented**",
  "**Across\rline**\n**Later**", "**Across\u2028line**\nrest", "**A**\r**B**", "**A**\u2029**B**",
  "** \r **\n**Next**", "**A\r**B**", "***Bad***\n**Good**", "**Title**\r\n", "\n \t\r\n", "😀\tfoo\nbar",
])("matches baseline at every UTF-16 boundary: %j", text => {
  const parser = new ThinkingTextParser();
  const epoch = {};
  for (let length = 0; length <= text.length; length++) expect(parser.read(text.slice(0, length), epoch)).toEqual(baseline(text.slice(0, length)));
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
