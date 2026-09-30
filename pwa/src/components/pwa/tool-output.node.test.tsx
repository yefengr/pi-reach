import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { JsonValue, TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { ToolOutput } from "./tool-output";
import { reliableToolDiff, toolHasOverflow } from "./tool-presentation";

const base = { event_id: "event", session_id: "s", leaf_id: "g", group_id: "group", timestamp: 0, kind: "tool" as const, tool_call_id: "call", status: "complete" as const, truncated: false };
function event(tool: string, args: JsonValue, result: JsonValue): Extract<TimelineEvent, { kind: "tool" }> {
  return { ...base, tool, args, result };
}
const render = (value: Parameters<typeof ToolOutput>[0]["value"], preview = true) => renderToStaticMarkup(<ToolOutput value={value} preview={preview} />);

test.each(["read", "write"])("%s displays raw source text without highlighting or a parameter JSON envelope", tool => {
  const content = "const answer = 42;";
  const value = event(tool, { path: "src/answer.ts", ...(tool === "write" ? { content } : {}) }, tool === "write" ? "Wrote file" : [{ type: "text", text: content }]);
  const html = render(value);
  // 工具输出为原始文本，不做语法高亮。
  expect(html).not.toContain("hljs");
  expect(html).toContain("const answer = 42;");
  expect(html).toContain("42");
  expect(html).not.toContain("&quot;path&quot;");
  expect(html).not.toContain("&quot;content&quot;");
});

test("bash full view preserves the multiline command and treats output as terminal text", () => {
  const value = event("bash", { command: "printf 'first\\n'\nprintf 'second\\n'" }, [{ type: "text", text: "first\nsecond" }]);
  const html = render(value, false);
  expect(html).toContain("printf");
  expect(html).toContain("first\nsecond");
  expect(html).not.toContain("&quot;command&quot;");
});

test("edit recognizes returned diff in native details and content blocks without fabricating one from input", () => {
  const args = { path: "src/file.ts", oldText: "old", newText: "new" };
  const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new";
  const results: JsonValue[] = [{ details: { diff }, content: [{ type: "text", text: "Done" }] }, { content: [{ type: "text", text: diff }] }, [{ type: "text", text: diff }]];
  for (const result of results) {
    const value = event("edit", args, result);
    expect(reliableToolDiff(value)).toBe(diff);
    const html = render(value);
    expect(html).toContain("pwa-tool-diff-add");
    expect(html).toContain("pwa-tool-diff-remove");
  }
  const requested = event("edit", { path: "file.ts", edits: [{ oldText: "ORIGINAL_TEXT", newText: "REPLACEMENT_TEXT" }] }, "Successfully replaced text");
  expect(reliableToolDiff(requested)).toBeUndefined();
  expect(render(requested)).toContain("Requested changes");
  expect(render(requested)).toContain("ORIGINAL_TEXT");
  expect(render(requested)).toContain("REPLACEMENT_TEXT");
  expect(render(requested)).not.toContain("Applied diff");
});

test("error and interruption remain explicit alongside available content", () => {
  const value = event("edit", { path: "file.ts", oldText: "a", newText: "b" }, "Partial output");
  const failure = render({ ...value, status: "error", error: "Permission denied" });
  expect(failure.match(/Permission denied/g)).toHaveLength(1);
  expect(failure).toContain("Partial output");
  expect(render({ ...base, tool: "edit", args: value.args, status: "interrupted" }).toLowerCase()).toContain("interrupted");
});

test("bounded inline content exposes a full view without losing write input or late output", () => {
  const text = `${"line\n".repeat(50)}END_OF_CONTENT`;
  for (const value of [event("read", { path: "data.txt" }, text), event("write", { path: "data.txt", content: text }, "Wrote file")]) {
    expect(toolHasOverflow(value)).toBe(true);
    expect(render(value)).not.toContain("END_OF_CONTENT");
    expect(render(value, false)).toContain("END_OF_CONTENT");
  }
  expect(toolHasOverflow(event("read", { path: "exit.txt" }, "0\n"))).toBe(false);
});

test("literal tool HTML is escaped even when a syntax language is recognized", () => {
  const source = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  for (const path of ["unsafe.html", "unknown.extension"]) {
    const html = render(event("read", { path }, source));
    expect(html).not.toMatch(/<(img|script)\b/i);
    expect(html).toContain("&lt;");
    expect(html).toContain("alert");
  }
});

test("recognized tools retain real structured results in inline and full content", () => {
  const value = event("bash", { command: "check" }, { stdout: "command output", exitCode: 0 });
  for (const preview of [true, false]) {
    const html = render(value, preview);
    expect(html).toContain("command output");
    expect(html).toContain("exitCode");
    expect(html).not.toContain("&quot;command&quot;");
  }
});

test("returned edit diff does not hide accompanying structured data or repeat consumed fields", () => {
  const diff = "--- a/file.ts\n+++ b/file.ts\n-old\n+new";
  const results: JsonValue[] = [
    { diff, message: "UPDATED_FILE", diagnostics: [{ severity: "warning", message: "REVIEW_MARKER" }] },
    { details: { diff, firstChangedLine: 1 }, diagnostics: ["REVIEW_MARKER"] },
  ];
  for (const result of results) {
    const value = event("edit", { path: "file.ts", oldText: "old", newText: "new" }, result);
    for (const preview of [true, false]) {
      const html = render(value, preview);
      expect(html).toContain("REVIEW_MARKER");
      expect(html).toContain("Returned diff");
      // 会话内预览最多 12 行，完整 diff 在阅读器中查看。
      if (!preview) expect(html).toContain("pwa-tool-diff-add");
      expect(html).not.toContain("&quot;diff&quot;");
    }
  }
});

test("host truncation and omitted images remain visible instead of implying a complete local copy", () => {
  const value = event("read", { path: "image.png" }, [{ type: "image", mime_type: "image/png", omitted: true, byte_length: 100 }]);
  const html = render({ ...value, truncated: true }, false);
  expect(html.toLowerCase()).toContain("omitted");
  expect(html.toLowerCase()).toContain("truncated");
  expect(html).not.toContain("<img");
});

test("command preview echoes the call as its first line without leaking arguments", () => {
  const value = event("bash", { command: "pnpm --filter pwa test:unit", cwd: "/workspace" }, [{ type: "text", text: "3 passed" }]);
  const html = render(value);
  expect(html).toContain("$ pnpm --filter pwa test:unit");
  expect(html).toContain("3 passed");
  expect(html.indexOf("$ pnpm")).toBeLessThan(html.indexOf("3 passed"));
  expect(html).not.toContain("&quot;command&quot;");
  expect(html).not.toContain("cwd");
});

test("bounds a long command echo so the result is still previewed", () => {
  const command = Array.from({ length: 30 }, (_, index) => `step ${index + 1}`).join("\n");
  const value = event("bash", { command }, "FINAL_RESULT");
  const preview = render(value);
  expect(preview).toContain("$ step 1");
  expect(preview).toContain("FINAL_RESULT");
  expect(preview).not.toContain("step 30");
  expect(toolHasOverflow(value)).toBe(true);
  expect(render(value, false)).toContain("step 30");
});

test("non-command previews keep their content without a call echo", () => {
  const value = event("read", { path: "src/answer.ts" }, [{ type: "text", text: "const answer = 42;" }]);
  expect(render(value)).not.toContain("$ ");
});
