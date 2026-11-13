import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { JsonValue, TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { ToolImage } from "./tool-output";
import { reliableToolDiff, toolContentBlocks, toolWasTruncated, type ToolContentBlock } from "./tool-presentation";

const base = { event_id: "event", session_id: "s", leaf_id: "g", group_id: "group", timestamp: 0, kind: "tool" as const, tool_call_id: "call", status: "complete" as const, truncated: false };
function event(tool: string, args: JsonValue, result: JsonValue): Extract<TimelineEvent, { kind: "tool"; status: "complete"; args: JsonValue }> {
  return { ...base, tool, args, result };
}
type TextBlock = Extract<ToolContentBlock, { kind: "text" }>;
const textBlocks = (value: Parameters<typeof toolContentBlocks>[0]) => toolContentBlocks(value).filter((block): block is TextBlock => block.kind === "text");
const texts = (value: Parameters<typeof toolContentBlocks>[0]) => textBlocks(value).map((block) => block.text);

test("read keeps raw source text as code without a parameter JSON envelope", () => {
  // 含 HTML 的源码原样作为文本交给阅读器，不做高亮或转换。
  for (const content of ["const answer = 42;", '<img src=x onerror="alert(1)"><script>alert(2)</script>']) {
    const blocks = textBlocks(event("read", { path: "src/answer.ts" }, [{ type: "text", text: content }]));
    expect(blocks).toEqual([expect.objectContaining({ text: content, style: "code", path: "src/answer.ts" })]);
  }
});

test("write and bash keep only the real result, without content copied from the input", () => {
  expect(texts(event("write", { path: "src/answer.ts", content: "FILE BODY" }, "Wrote file"))).toEqual(["Wrote file"]);
  const bash = textBlocks(event("bash", { command: "printf 'first\\n'\nprintf 'second\\n'" }, [{ type: "text", text: "first\nsecond" }]));
  expect(bash).toEqual([expect.objectContaining({ text: "first\nsecond", style: "terminal" })]);
});

test("edit recognizes returned diff in native details and content blocks without fabricating one from input", () => {
  const args = { path: "src/file.ts", oldText: "old", newText: "new" };
  const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new";
  const results: JsonValue[] = [{ details: { diff }, content: [{ type: "text", text: "Done" }] }, { content: [{ type: "text", text: diff }] }, [{ type: "text", text: diff }]];
  for (const result of results) {
    const value = event("edit", args, result);
    expect(reliableToolDiff(value)).toBe(diff);
    expect(textBlocks(value).filter((block) => block.style === "diff")).toEqual([expect.objectContaining({ text: diff, label: "Returned diff" })]);
  }
  const requested = event("edit", { path: "file.ts", edits: [{ oldText: "ORIGINAL_TEXT", newText: "REPLACEMENT_TEXT" }] }, "Successfully replaced text");
  expect(reliableToolDiff(requested)).toBeUndefined();
  expect(texts(requested)).toEqual(["Successfully replaced text"]);
});

test("error and interruption remain explicit alongside available content", () => {
  const value = event("edit", { path: "file.ts", oldText: "a", newText: "b" }, "Partial output");
  const failure = textBlocks({ ...value, status: "error", error: "Permission denied" });
  expect(failure.filter((block) => block.text.includes("Permission denied"))).toEqual([expect.objectContaining({ style: "error" })]);
  expect(failure.map((block) => block.text)).toContain("Partial output");
  const interrupted = textBlocks({ ...base, tool: "edit", args: value.args, status: "interrupted" });
  expect(interrupted.some((block) => block.style === "notice" && block.text.toLowerCase().includes("interrupted"))).toBe(true);
});

test("recognized tools retain real structured results", () => {
  const joined = texts(event("bash", { command: "check" }, { stdout: "command output", exitCode: 0 })).join("\n");
  expect(joined).toContain("command output");
  expect(joined).toContain("exitCode");
  expect(joined).not.toContain('"command"');
});

test("returned edit diff does not hide accompanying structured data or repeat consumed fields", () => {
  const diff = "--- a/file.ts\n+++ b/file.ts\n-old\n+new";
  const results: JsonValue[] = [
    { diff, message: "UPDATED_FILE", diagnostics: [{ severity: "warning", message: "REVIEW_MARKER" }] },
    { details: { diff, firstChangedLine: 1 }, diagnostics: ["REVIEW_MARKER"] },
  ];
  for (const result of results) {
    const blocks = textBlocks(event("edit", { path: "file.ts", oldText: "old", newText: "new" }, result));
    const rest = blocks.filter((block) => block.style !== "diff").map((block) => block.text).join("\n");
    expect(rest).toContain("REVIEW_MARKER");
    expect(rest).not.toContain('"diff"');
    expect(blocks.filter((block) => block.style === "diff")).toEqual([expect.objectContaining({ text: diff, label: "Returned diff" })]);
  }
});

test("host truncation and omitted images remain visible instead of implying a complete local copy", () => {
  const value = { ...event("read", { path: "image.png" }, [{ type: "image", mime_type: "image/png", omitted: true, byte_length: 100 }]), truncated: true };
  expect(toolWasTruncated(value)).toBe(true);
  const [image] = toolContentBlocks(value);
  expect(image).toMatchObject({ kind: "image", omitted: true });
  if (image.kind !== "image") throw new Error("expected an image block");
  const html = renderToStaticMarkup(<ToolImage block={image} index={0} />);
  expect(html.toLowerCase()).toContain("omitted");
  expect(html).not.toContain("<img");
});
