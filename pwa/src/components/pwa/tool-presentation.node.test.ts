import { expect, test } from "vitest";
import type { JsonValue, TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { reliableToolDiff, safeJsonText, TOOL_HEADER_MAX_LINES, toolAction, toolCommandLead, toolContentBlocks, toolContentView, toolHeaderSummary, toolReaderCall, toolReaderContent } from "./tool-presentation";

const base = { event_id: "e", session_id: "s", leaf_id: "g", group_id: "group", timestamp: 1, kind: "tool" as const, tool_call_id: "call", truncated: false, status: "complete" as const };
function event(tool: string, args: JsonValue, result: JsonValue): Extract<TimelineEvent, { kind: "tool" }> {
  return { ...base, tool, args, result };
}

test("uses specialized views only when tool name and required input are clear", () => {
  expect(toolAction(event("read", { path: "src/file.ts" }, "text"))).toMatchObject({ kind: "read", label: "Read file", detail: "src/file.ts" });
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

test("keeps one command title form and echoes the full call only into expanded content", () => {
  const value = event("bash", { command: "pwd\nls -al" }, "result");
  expect(toolHeaderSummary(value)).toBe("pwd ls -al");
  expect(toolCommandLead(value)).toBe("$ pwd\nls -al");
  expect(toolCommandLead(event("read", { path: "src/file.ts" }, "text"))).toBeUndefined();

  const preview = toolContentView(value, true);
  expect(preview.blocks[0]).toEqual({ kind: "text", text: "$ pwd\nls -al", style: "terminal" });
  expect(toolContentView(value, false).blocks[0]).not.toEqual(preview.blocks[0]);
  // 阅读器正文只保留真实结果，命令回显留在展开预览首行。
  expect(toolContentBlocks(value).some((block) => block.kind === "text" && block.text.startsWith("$ "))).toBe(false);
});

test("the reader call line follows the Pi native call format without a prompt", () => {
  const cases: [string, Record<string, JsonValue>, string | undefined][] = [
    ["bash", { command: "pwd\nls -al" }, "pwd\nls -al"],
    ["bash", { command: "pnpm test", timeout: 30 }, "pnpm test (timeout 30s)"],
    ["read", { path: "src/file.ts" }, "src/file.ts"],
    ["read", { path: "src/file.ts", offset: 20, limit: 10 }, "src/file.ts:20-29"],
    ["read", { path: "src/file.ts", offset: 20 }, "src/file.ts:20"],
    ["read", { path: "src/file.ts", limit: 10 }, "src/file.ts:1-10"],
    // 路径恰为工具名时照常显示。
    ["read", { path: "read" }, "read"],
    ["edit", { path: "src/file.ts", oldText: "a", newText: "b" }, "src/file.ts"],
    ["write", { path: "src/file.ts", content: "body" }, "src/file.ts"],
    ["grep", { pattern: "TODO", path: "src", glob: "*.ts", limit: 5 }, "/TODO/ in src (*.ts) limit 5"],
    ["grep", { pattern: "TODO" }, "/TODO/ in ."],
    ["find", { pattern: "*.ts", path: "src", limit: 5 }, "*.ts in src (limit 5)"],
    // 不同字段恰好同值时各自显示。
    ["grep", { pattern: "*.ts", glob: "*.ts" }, "/*.ts/ in . (*.ts)"],
    // 通用工具和插件的同类别名由正文的完整参数块承担调用展示。
    ["deploy", { target: "prod" }, undefined],
    ["shell", { command: "build", cwd: "/tmp" }, undefined],
    ["rg", { pattern: "TODO" }, undefined],
    ["glob", { pattern: "*.ts" }, undefined],
    // 同名覆盖的内置工具新增参数，或调用行不显示的选项，同样改以完整参数块展示。
    ["bash", { command: "build", cwd: "/tmp" }, undefined],
    ["grep", { pattern: "TODO", ignoreCase: true }, undefined],
    ["read", { file_path: "src/file.ts" }, undefined],
    // 必填字段缺失或修改无法组成 diff 时，调用行不足以表达参数。
    ["bash", { timeout: 30 }, undefined],
    ["edit", { path: "src/file.ts", edits: [{ oldText: 1 }] }, undefined],
    ["write", { path: "src/file.ts" }, undefined],
  ];
  for (const [tool, args, expected] of cases) {
    expect(toolReaderCall(event(tool, args, "result")), `${tool} ${JSON.stringify(args)}`).toBe(expected);
  }
});

test("reader content keeps every argument of aliased or overridden tools and does not duplicate generic parameters", () => {
  const alias = toolReaderContent(event("shell", { command: "build", cwd: "/tmp" }, "built"));
  expect(alias.call).toBeUndefined();
  expect(alias.blocks[0]).toMatchObject({ kind: "text", style: "json" });
  expect(alias.blocks[0].kind === "text" && alias.blocks[0].text).toContain('"cwd": "/tmp"');
  expect(alias.blocks.some((block) => block.kind === "text" && block.text.includes("built"))).toBe(true);

  const generic = toolReaderContent(event("deploy", { target: "prod" }, "ok"));
  expect(generic.blocks.filter((block) => block.kind === "text" && block.style === "json" && block.text.includes('"target"'))).toHaveLength(1);

  const overridden = toolReaderContent(event("bash", { command: "build", cwd: "/tmp" }, "built"));
  expect(overridden.call).toBeUndefined();
  expect(overridden.blocks[0].kind === "text" && overridden.blocks[0].text).toContain('"cwd": "/tmp"');

  const native = toolReaderContent(event("bash", { command: "pwd" }, "/home"));
  expect(native.call).toBe("pwd");
  expect(native.blocks.some((block) => block.kind === "text" && block.style === "json")).toBe(false);
});

test("bounds the preview command echo so the real result keeps its budget", () => {
  const command = Array.from({ length: 30 }, (_, index) => `step ${index + 1}`).join("\n");
  const value = event("bash", { command }, "REAL_RESULT");
  const preview = toolContentView(value, true);
  const lead = preview.blocks[0];
  expect(lead.kind === "text" && lead.text.endsWith("…")).toBe(true);
  expect(lead.kind === "text" && lead.text.split("\n").length).toBeLessThanOrEqual(TOOL_HEADER_MAX_LINES + 1);
  expect(preview.clipped).toBe(true);
  expect(preview.blocks.some((block) => block.kind === "text" && block.text === "REAL_RESULT")).toBe(true);
});
