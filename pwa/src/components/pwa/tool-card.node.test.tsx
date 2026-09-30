import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PwaUiProvider } from "./pwa-ui-provider";

const renderCard = (node: ReactNode) => renderToStaticMarkup(<PwaUiProvider>{node}</PwaUiProvider>);
import { expect, test } from "vitest";
import { ToolCard } from "./tool-card";
import type { ToolStatus, ToolValue } from "./tool-presentation";

const base = {
  event_id: "event", session_id: "session", leaf_id: "generation", group_id: "group",
  timestamp: 1, kind: "tool" as const, tool_call_id: "call", truncated: false,
  tool: "edit", args: { path: "src/file.ts", oldText: "old", newText: "INPUT_MARKER" },
};
const value: ToolValue = {
  ...base, status: "complete",
  result: { diff: "--- a/file.ts\n+++ b/file.ts\n-old\n+OUTPUT_MARKER", content: [{ type: "image", mimeType: "image/png", data: "IMAGE_MARKER" }] },
};
const errorValue: ToolValue = { ...base, status: "error", error: "ERROR_MARKER" };
const interruptedValue: ToolValue = { ...base, status: "interrupted" };
const fixtures: Record<ToolStatus, ToolValue> = {
  running: value, complete: value, error: errorValue, interrupted: interruptedValue, unknown: value,
};
const statuses: ToolStatus[] = ["running", "complete", "error", "interrupted", "unknown"];

// 覆盖正式事件默认状态，以及父级覆盖流式状态的入口。
test.each(statuses)("starts %s tools collapsed without mounting any input or result", (status) => {
  const html = renderCard(<ToolCard value={fixtures[status]} status={status} onRead={() => {}} />);
  const label = status === "unknown" ? "Status unknown" : status[0].toUpperCase() + status.slice(1);
  expect(html).toContain('aria-label="Expand edit tool"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain(`role="status" aria-label="edit: ${label}"`);
  for (const hidden of ["pwa-tool-content", "INPUT_MARKER", "OUTPUT_MARKER", "IMAGE_MARKER", "ERROR_MARKER", "<pre", "<img", "Details", "Raw data"]) {
    expect(html).not.toContain(hidden);
  }
});

test.each(statuses)("honors explicit expansion for %s tools with direct readable content", (status) => {
  const html = renderCard(<ToolCard value={fixtures[status]} status={status} expanded onRead={() => {}} />);
  expect(html).toContain('aria-label="Collapse edit tool"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain("pwa-tool-content");
  if (status === "error" || status === "interrupted") expect(html).not.toContain("View all");
  else expect(html).toContain(">View all<");
  expect(html).not.toContain("Raw data");
  expect(html).not.toContain('aria-label="Tool input"');
  expect(html).not.toContain(">Input<");
  expect(html).not.toContain(">Output<");
  expect(html).not.toContain("&quot;oldText&quot;");
  expect(html).toContain(status === "error" ? "ERROR_MARKER" : status === "interrupted" ? "INPUT_MARKER" : "OUTPUT_MARKER");
});

test("read of a short exit file shows the value directly without input JSON or a redundant full-view button", () => {
  const html = renderCard(<ToolCard value={{ ...base, tool: "read", args: { path: ".pi/tmp/logs/check.exit" }, result: [{ type: "text", text: "0\n" }], status: "complete" }} expanded onRead={() => {}} />);
  expect(html).toMatch(/>0\n?</);
  expect(html).not.toContain("&quot;path&quot;");
  expect(html).not.toContain("View all");
  expect(html).not.toContain(">Input<");
  expect(html).not.toContain(">Output<");
});

test("long write input can be read in full even when its result is short", () => {
  const content = `${"const value = 1;\n".repeat(100)}FINAL_WRITE_LINE`;
  const current: ToolValue = { ...base, tool: "write", args: { path: "src/file.ts", content }, result: "Wrote file", status: "complete" };
  const html = renderCard(<ToolCard value={current} expanded onRead={() => {}} />);
  expect(html).toMatch(/View all \(\d+ lines\)/);
  expect(html).not.toContain("FINAL_WRITE_LINE");
  expect(html).not.toContain("&quot;content&quot;");
});

test("renders separate calls as separate collapsed articles", () => {
  const html = renderCard(<><ToolCard value={value} /><ToolCard value={{ ...value, tool_call_id: "second-call" }} /></>);
  expect(html.match(/<article /g)).toHaveLength(2);
  expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
  expect(html).toContain("second-call");
});

test("keeps one command title before and after expanding and echoes the call inside the preview", () => {
  const commandValue: ToolValue = { ...base, tool: "bash", args: { command: "pnpm --filter pwa test:unit" }, result: [{ type: "text", text: "3 passed" }], status: "complete" };
  const collapsed = renderCard(<ToolCard value={commandValue} onRead={() => {}} />);
  const expanded = renderCard(<ToolCard value={commandValue} expanded onRead={() => {}} />);
  const title = '<span title="pnpm --filter pwa test:unit">pnpm --filter pwa test:unit</span>';
  expect(collapsed).toContain(title);
  expect(expanded).toContain(title);
  expect(collapsed).not.toContain("$ pnpm");
  expect(expanded).toContain("$ pnpm --filter pwa test:unit");
  expect(expanded).not.toContain("&quot;command&quot;");
});
