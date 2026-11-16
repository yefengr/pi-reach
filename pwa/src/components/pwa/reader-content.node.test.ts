import { expect, test } from "vitest";
import type { JsonValue, TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { countTextLines, readerResultBlocks, readToolContent, writeToolContent } from "./reader-content";
import type { ToolValue } from "./tool-presentation";

const base = { event_id: "e", session_id: "s", leaf_id: "g", group_id: "group", timestamp: 1, kind: "tool" as const, tool_call_id: "call", truncated: false, status: "complete" as const };
function event(tool: string, args: JsonValue, result: JsonValue): Extract<TimelineEvent, { kind: "tool"; status: "complete"; args: JsonValue }> {
  return { ...base, tool, args, result };
}
function failed(tool: string, args: JsonValue, error: string, result?: JsonValue): ToolValue {
  return { ...base, tool, args, status: "error", error, ...(result === undefined ? {} : { result }) } as unknown as ToolValue;
}

test("reads the whole returned text with one-based line numbers and keeps the trailing newline", () => {
  expect(readToolContent(event("read", { path: "a.ts" }, "alpha\nbeta\n"))).toEqual({
    text: "alpha\nbeta\n",
    startLine: 1,
    endLine: 2,
    partial: false,
  });
  expect(countTextLines("alpha\nbeta\n")).toBe(2);
  expect(countTextLines("alpha\n\n")).toBe(2);
  expect(countTextLines("")).toBe(0);
});

test("counts lines from the real content instead of the requested limit", () => {
  expect(readToolContent(event("read", { path: "a.ts", offset: 53, limit: 100 }, "one\ntwo\nthree"))).toEqual({
    text: "one\ntwo\nthree",
    startLine: 53,
    endLine: 55,
    partial: true,
  });
});

test("strips the three trailing continuation notices and only then counts lines", () => {
  const lines = "alpha\nbeta\n\n[Showing lines 10-11 of 40. Use offset=12 to continue.]";
  expect(readToolContent(event("read", { path: "a.ts", offset: 10 }, lines))).toEqual({
    text: "alpha\nbeta",
    startLine: 10,
    endLine: 11,
    notice: "[Showing lines 10-11 of 40. Use offset=12 to continue.]",
    partial: true,
  });

  const bytes = "alpha\n\n[Showing lines 1-1 of 9 (50KB limit). Use offset=2 to continue.]";
  expect(readToolContent(event("read", { path: "big.txt" }, bytes))).toEqual({
    text: "alpha",
    startLine: 1,
    endLine: 1,
    notice: "[Showing lines 1-1 of 9 (50KB limit). Use offset=2 to continue.]",
    partial: true,
  });

  const remaining = "alpha\nbeta\n\n[8 more lines in file. Use offset=3 to continue.]";
  expect(readToolContent(event("read", { path: "a.ts" }, remaining))).toEqual({
    text: "alpha\nbeta",
    startLine: 1,
    endLine: 2,
    notice: "[8 more lines in file. Use offset=3 to continue.]",
    partial: true,
  });
});

test("keeps the trailing newline as a terminator without a continuation notice", () => {
  expect(readToolContent(event("read", { path: "a.ts" }, "alpha\n"))).toEqual({
    text: "alpha\n",
    startLine: 1,
    endLine: 1,
    partial: false,
  });
});

test("uses the SDK continuation offset to keep a trailing empty selected line", () => {
  const content = "alpha\n\n\n[2 more lines in file. Use offset=3 to continue.]";
  expect(readToolContent(event("read", { path: "a.ts", offset: 1, limit: 2 }, content))).toEqual({
    text: "alpha\n",
    startLine: 1,
    endLine: 2,
    notice: "[2 more lines in file. Use offset=3 to continue.]",
    partial: true,
  });

  const mismatched = "alpha\n\n\n[2 more lines in file. Use offset=5 to continue.]";
  expect(readToolContent(event("read", { path: "a.ts", offset: 1, limit: 2 }, mismatched))).toEqual({
    text: "alpha\n",
    startLine: 1,
    endLine: 1,
    notice: "[2 more lines in file. Use offset=5 to continue.]",
    partial: true,
  });
});

test("never strips notices that are not exactly at the end and preceded by a blank line", () => {
  const embedded = "alpha\n\n[Showing lines 1-1 of 2. Use offset=2 to continue.]\ntail";
  expect(readToolContent(event("read", { path: "a.ts" }, embedded))).toEqual({
    text: embedded,
    startLine: 1,
    endLine: 4,
    partial: false,
  });

  const noBlankLine = "alpha\n[Showing lines 1-1 of 2. Use offset=2 to continue.]";
  expect(readToolContent(event("read", { path: "a.ts" }, noBlankLine))).toEqual({
    text: noBlankLine,
    startLine: 1,
    endLine: 2,
    partial: false,
  });
});

test("does not assign line numbers to invalid explicit offsets while keeping the real text", () => {
  for (const offset of [0, -1, 1.5, "10", null]) {
    expect(readToolContent(event("read", { path: "a.ts", offset }, "alpha\nbeta"))).toEqual({
      text: "alpha\nbeta",
      partial: true,
    });
  }
  expect(readToolContent(event("read", { path: "a.ts", start_line: 7 }, "alpha\nbeta"))).toMatchObject({
    startLine: 7,
    endLine: 8,
  });
});

test("marks real truncation and limited details as partial without a continuation notice", () => {
  const truncated = { ...event("read", { path: "a.ts" }, "alpha\nbeta"), truncated: true };
  expect(readToolContent(truncated)).toEqual({
    text: "alpha\nbeta",
    startLine: 1,
    endLine: 2,
    partial: true,
  });

  const limited = { ...event("read", { path: "a.md" }, "alpha"), source: "session", limited: true } as unknown as ToolValue;
  expect(readToolContent(limited)).toEqual({ text: "alpha", startLine: 1, endLine: 1, partial: true });
});

test("omits an unsafe end line instead of publishing an unreliable range", () => {
  expect(readToolContent(event("read", { path: "a.ts", start_line: Number.MAX_SAFE_INTEGER }, "alpha\nbeta"))).toEqual({
    text: "alpha\nbeta",
    partial: true,
  });
});

test("returns an empty body without a range and treats a byte-limit-only result as a notice", () => {
  expect(readToolContent(event("read", { path: "a.ts" }, ""))).toEqual({ text: "", partial: false });

  const onlyNotice = "[Line 1 is 80KB, exceeds 50KB limit. Use bash: sed -n '1p' big.txt | head -c 51200]";
  expect(readToolContent(event("read", { path: "big.txt" }, onlyNotice))).toEqual({
    text: "",
    notice: onlyNotice,
    partial: true,
  });
});

test("rejects read content when the result is not one reliable text block", () => {
  const image = event("read", { path: "a.png" }, [{ type: "image", mimeType: "image/png", data: "AAAA", byte_length: 4 }]);
  expect(readToolContent(image)).toBeUndefined();
  expect(readToolContent(event("read", { path: "a.ts" }, [{ type: "text", text: "a" }, { type: "text", text: "b" }]))).toBeUndefined();
  expect(readToolContent(event("bash", { command: "cat a.ts" }, "alpha"))).toBeUndefined();
  expect(readToolContent(failed("read", { path: "a.ts" }, "Could not read file", "alpha"))).toBeUndefined();
});

test("does not number the SDK image-processing failure note as file text", () => {
  const imageNote = "Read image file [image/png]\nUnable to process image: unsupported format";
  const value = event("read", { path: "a.png" }, imageNote);
  expect(readToolContent(value)).toBeUndefined();
  expect(readerResultBlocks(value)).toEqual([expect.objectContaining({ kind: "text", text: imageNote })]);
});

test("returns only the write request content, including an empty string", () => {
  expect(writeToolContent(event("write", { path: "a.md", content: "# Title\n\nBody\n" }, "Successfully wrote to a.md"))).toBe("# Title\n\nBody\n");
  expect(writeToolContent(event("write", { path: "a.md", content: "" }, "Successfully wrote to a.md"))).toBe("");
  expect(writeToolContent(event("write", { path: "a.md", content: 42 }, "Successfully wrote to a.md"))).toBeUndefined();
  expect(writeToolContent(event("write", { content: "no path" }, "Successfully wrote to a.md"))).toBeUndefined();
  expect(writeToolContent(event("edit", { path: "a.md", content: "not a write" }, "ok"))).toBeUndefined();
});

test("hides only the exact built-in edit and write success receipts", () => {
  const texts = (blocks: ReturnType<typeof readerResultBlocks>) => blocks.flatMap((block) => (block.kind === "text" ? [block.text] : []));
  expect(texts(readerResultBlocks(event("edit", { path: "a.ts", oldText: "old", newText: "new" }, "Successfully replaced 1 block(s) in /repo/a.ts.")))).toEqual([]);
  expect(texts(readerResultBlocks(event("edit", { path: "a.ts", oldText: "old", newText: "new" }, "Successfully replaced 12 block(s) in a.ts.")))).toEqual([]);
  expect(texts(readerResultBlocks(event("write", { path: "a.md", content: "body" }, "Successfully wrote to /repo/a.md")))).toEqual([]);

  // 未识别的回执、近似文案、实际错误与真实后续数据都保留。
  expect(texts(readerResultBlocks(event("edit", { path: "a.ts", oldText: "old", newText: "new" }, "Applied")))).toEqual(["Applied"]);
  expect(texts(readerResultBlocks(event("edit", { path: "a.ts", oldText: "old", newText: "new" }, "Successfully replaced 2 blocks in a.ts.")))).toEqual(["Successfully replaced 2 blocks in a.ts."]);
  expect(texts(readerResultBlocks(event("write", { path: "a.md", content: "body" }, "Wrote a.md")))).toEqual(["Wrote a.md"]);
  expect(texts(readerResultBlocks(failed("write", { path: "a.md", content: "body" }, "EACCES: permission denied")))).toEqual(["EACCES: permission denied"]);
  expect(texts(readerResultBlocks(event("bash", { command: "echo" }, "Successfully wrote to a.md")))).toEqual(["Successfully wrote to a.md"]);
});

test("keeps images and substantive blocks next to a hidden receipt", () => {
  const edit = event("edit", { path: "a.ts", oldText: "old", newText: "new" }, [
    { type: "text", text: "Successfully replaced 1 block(s) in a.ts." },
    { type: "image", mimeType: "image/png", data: "AAAA", byte_length: 4 },
  ]);
  const blocks = readerResultBlocks(edit);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ kind: "image", mime: "image/png", data: "AAAA" });

  const write = event("write", { path: "a.md", content: "body" }, [
    { type: "text", text: "Successfully wrote to a.md" },
    { type: "text", text: "Backup saved" },
  ]);
  expect(writeToolContent(write)).toBe("body");
  expect(readerResultBlocks(write)).toEqual([expect.objectContaining({ kind: "text", text: "Backup saved" })]);
});
