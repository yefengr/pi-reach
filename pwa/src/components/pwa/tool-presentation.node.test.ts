import { expect, test } from "vitest";
import type { JsonValue, TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { diffLineKind, reliableToolDiff, safeJsonText, toolAction, toolCallCopy, toolContentBlocks, toolDiffStats, toolHeaderSummary, toolReaderCall } from "./tool-presentation";

const base = { event_id: "e", session_id: "s", leaf_id: "g", group_id: "group", timestamp: 1, kind: "tool" as const, tool_call_id: "call", truncated: false, status: "complete" as const };
function event(tool: string, args: JsonValue, result: JsonValue): Extract<TimelineEvent, { kind: "tool"; status: "complete"; args: JsonValue }> {
  return { ...base, tool, args, result };
}

test("uses specialized views only when tool name and required input are clear", () => {
  expect(toolAction(event("read", { path: "src/file.ts" }, "text"))).toMatchObject({ kind: "read", icon: "read", label: "Read", detail: "src/file.ts" });
  expect(toolAction(event("bread", { path: "src/file.ts" }, "text")).kind).toBe("generic");
  expect(toolAction(event("bash", {}, "text")).kind).toBe("generic");
});

test("summarizes read paths and requested line ranges without guessing result length", () => {
  expect(toolHeaderSummary(event("read", { path: "src/file.ts", offset: 20, limit: 10 }, "one line"))).toBe("src/file.ts · L20–29");
  expect(toolHeaderSummary(event("read", { path: "src/file.ts", limit: 10 }, "text"))).toBe("src/file.ts · L1–10");
  expect(toolHeaderSummary(event("read", { path: "src/file.ts", offset: 20 }, "text"))).toBe("src/file.ts · L20+");
  expect(toolHeaderSummary(event("read", { path: "src/file.ts", limit: -1 }, "text"))).toBe("src/file.ts");
  expect(toolHeaderSummary(event("read", { path: "src/file.ts", offset: Number.MAX_SAFE_INTEGER, limit: 2 }, "text"))).toBe(`src/file.ts · L${Number.MAX_SAFE_INTEGER}+`);
});

test("keeps command and search summaries on one line and unknown tools conservative", () => {
  expect(toolHeaderSummary(event("bash", { command: "pwd\nls\t-al" }, "result"))).toBe("pwd ls -al");
  expect(toolHeaderSummary(event("grep", { pattern: "needle", path: "src" }, "result"))).toBe("needle");
  expect(toolHeaderSummary(event("edit", { path: "file.ts", newText: "private content" }, "result"))).toBe("file.ts");
  expect(toolHeaderSummary(event("custom", { path: "not inferred", token: "private" }, "result"))).toBe("path · token");
});

test("row copy leads with a verb and keeps the file name ahead of its directory", () => {
  expect(toolCallCopy(event("read", { path: "pwa/src/a.tsx", offset: 1, limit: 120 }, "text"))).toEqual({ kind: "read", label: "Read", target: "a.tsx · L1–120", context: "pwa/src", title: "pwa/src/a.tsx · L1–120" });
  expect(toolCallCopy(event("edit", { path: "C:\\repo\\b.css" }, "ok"))).toMatchObject({ label: "Edit", target: "b.css", context: "C:\\repo" });
  expect(toolCallCopy(event("write", { path: "notes.md" }, "ok"))).toMatchObject({ label: "Write", target: "notes.md", context: "" });
  expect(toolCallCopy(event("write", { path: "/notes.md" }, "ok"))).toMatchObject({ target: "/notes.md", context: "" });
  // 命令与搜索词不拆分路径；无法分类的工具保留原始工具名与参数摘要。
  expect(toolCallCopy(event("bash", { command: "pnpm --filter pwa lint" }, "ok"))).toMatchObject({ label: "Run", target: "pnpm --filter pwa lint", context: "" });
  expect(toolCallCopy(event("grep", { pattern: "needle", path: "src" }, "ok"))).toMatchObject({ label: "Search", target: "needle", context: "" });
  expect(toolCallCopy(event("deploy", { target: "prod" }, "ok"))).toMatchObject({ label: "deploy", target: "target", context: "" });
});

test("diff stats count only lines of a diff the edit tool actually returned", () => {
  const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n context\n-old\n-older\n+new\n+--flag\n";
  expect(toolDiffStats(event("edit", { path: "file.ts" }, { diff }))).toEqual({ added: 2, removed: 2 });
  expect(toolDiffStats(event("edit", { path: "file.ts", oldText: "old", newText: "new" }, "Applied"))).toBeUndefined();
  expect(toolDiffStats(event("bash", { command: "git diff" }, diff))).toBeUndefined();
  expect(diffLineKind("+++ b/file.ts")).toBeUndefined();
  expect(diffLineKind("-removed")).toBe("remove");
});

test("does not present edit input as an applied diff", () => {
  const requested = event("edit", { path: "file.ts", oldText: "old", newText: "new" }, "Applied");
  expect(reliableToolDiff(requested)).toBeUndefined();
  expect(reliableToolDiff(event("edit", { path: "file.ts" }, "--- a/file.ts\n+++ b/file.ts\n@@\n-old\n+new"))).toContain("+new");
});

test("keeps structured output readable without exposing image bytes", () => {
  const value = event("custom", {}, [{ type: "image", mime_type: "image/png", data: "AAAA-real-image-data", byte_length: 18 }]);
  const text = safeJsonText(value.result);
  expect(text).toContain("image data omitted");
  expect(text).not.toContain("AAAA-real-image-data");
});

test("keeps one command title form and never echoes the call into the reader body", () => {
  const value = event("bash", { command: "pwd\nls -al" }, "result");
  expect(toolHeaderSummary(value)).toBe("pwd ls -al");
  // 阅读器正文只保留真实结果，完整调用由首块的参数列表承担。
  expect(toolContentBlocks(value).some((block) => block.kind === "text" && block.text.startsWith("$ "))).toBe(false);
});

test("the reader call lists every argument as is: text raw, other values as JSON", () => {
  const cases: [string, JsonValue, string | undefined][] = [
    ["bash", { command: "pwd\nls -al", timeout: 30 }, "command: pwd\nls -al\ntimeout: 30"],
    // 名称与内置工具相同或类型不合常规的值同样原样显示，不做任何推断或省略。
    ["bash", { command: "build", timeout: "slow", cwd: "/tmp" }, "command: build\ntimeout: slow\ncwd: /tmp"],
    ["read", { path: "a", limit: -1 }, "path: a\nlimit: -1"],
    ["grep", { pattern: "*.ts", glob: "*.ts" }, "pattern: *.ts\nglob: *.ts"],
    ["deploy", { target: "prod", force: true, tags: ["a", "b"] }, 'target: prod\nforce: true\ntags: [\n  "a",\n  "b"\n]'],
    ["custom", "raw input", "raw input"],
    // 参数里的图片不会在输出中渲染，只标明已省略，不误写成「已在输出中渲染」。
    ["attach", { asset: { type: "image", data: "AAAA" } }, 'asset: {\n  "type": "image",\n  "data": "[image data omitted]"\n}'],
    ["status", {}, undefined],
  ];
  for (const [tool, args, expected] of cases) {
    expect(toolReaderCall(event(tool, args, "result")), `${tool} ${JSON.stringify(args)}`).toBe(expected);
  }
});

test("the reader keeps only real results, without blocks copied from the input", () => {
  const texts = (blocks: ReturnType<typeof toolContentBlocks>) => blocks.flatMap((block) => block.kind === "text" ? [block.text] : []);
  expect(texts(toolContentBlocks(event("deploy", { target: "prod" }, "ok")))).toEqual(["ok"]);
  expect(texts(toolContentBlocks(event("write", { path: "a.txt", content: "FILE BODY" }, "Wrote a.txt")))).toEqual(["Wrote a.txt"]);
  expect(texts(toolContentBlocks(event("edit", { path: "a.txt", oldText: "old", newText: "new" }, "Edited a.txt")))).toEqual(["Edited a.txt"]);
});
