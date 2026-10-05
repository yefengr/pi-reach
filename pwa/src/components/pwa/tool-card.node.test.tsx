import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PwaUiProvider } from "./pwa-ui-provider";
import { ToolCard, ToolGroupCard, toolGroupSummary } from "./tool-card";
import type { ToolStatus, ToolValue } from "./tool-presentation";
import { en } from "@/lib/i18n/messages/en";
import { zh } from "@/lib/i18n/messages/zh";

const renderCard = (node: ReactNode) => renderToStaticMarkup(<PwaUiProvider>{node}</PwaUiProvider>);
const base = {
  event_id: "event", session_id: "session", leaf_id: "generation", group_id: "group",
  timestamp: 1, kind: "tool" as const, tool_call_id: "call", truncated: false,
  tool: "edit", args: { path: "src/file.ts", oldText: "old", newText: "INPUT_MARKER" },
};
const value: ToolValue = {
  ...base, status: "complete",
  result: { diff: "--- a/file.ts\n+++ b/file.ts\n-old\n+OUTPUT_MARKER", content: [{ type: "image", mimeType: "image/png", data: "IMAGE_MARKER" }] },
};
const fixtures: Record<ToolStatus, ToolValue> = {
  running: value, complete: value, error: { ...base, status: "error", error: "ERROR_MARKER" },
  interrupted: { ...base, status: "interrupted" }, unknown: value,
};
const statuses: ToolStatus[] = ["running", "complete", "error", "interrupted", "unknown"];

test.each(statuses)("%s tools expose a dialog action and status without inline content or a chevron", status => {
  const html = renderCard(<ToolCard value={fixtures[status]} status={status} onRead={() => {}} />);
  const label = status === "unknown" ? "Status unknown" : status[0].toUpperCase() + status.slice(1);
  expect(html).toContain('aria-label="View edit tool details"');
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).toContain(`role="status" aria-label="edit: ${label}"`);
  expect(html).toContain('title="src/file.ts"');
  for (const hidden of ["aria-expanded", "aria-controls", "pwa-tool-chevron", "pwa-tool-content", "INPUT_MARKER", "OUTPUT_MARKER", "IMAGE_MARKER", "ERROR_MARKER", "<pre", "<img", "View all", "pwa-tool-details"]) {
    expect(html).not.toContain(hidden);
  }
});

test("short read output and long write input use the same direct dialog entry", () => {
  const values: ToolValue[] = [
    { ...base, tool: "read", args: { path: ".pi/tmp/logs/check.exit" }, result: "SHORT_OUTPUT_MARKER", status: "complete" },
    { ...base, tool: "write", args: { path: "src/file.ts", content: `${"const value = 1;\n".repeat(100)}FINAL_WRITE_LINE` }, result: "Wrote file", status: "complete" },
  ];
  for (const current of values) {
    const html = renderCard(<ToolCard value={current} onRead={() => {}} />);
    expect(html).toContain(`aria-label="View ${current.tool} tool details"`);
    expect(html).not.toContain("SHORT_OUTPUT_MARKER");
    expect(html).not.toContain("FINAL_WRITE_LINE");
    expect(html).not.toContain("View all");
    expect(html).not.toContain("&quot;content&quot;");
  }
});

test("renders separate calls as separate dialog actions", () => {
  const html = renderCard(<><ToolCard value={value} onRead={() => {}} /><ToolCard value={{ ...value, tool_call_id: "second-call" }} onRead={() => {}} /></>);
  expect(html.match(/<article /g)).toHaveLength(2);
  expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(2);
  expect(html).not.toContain("aria-expanded");
  expect(html).toContain("second-call");
});

test("keeps command title and localized detail action without echoing the call inline", () => {
  const current: ToolValue = { ...base, tool: "bash", args: { command: "pnpm --filter pwa test:unit" }, result: "3 passed", status: "complete" };
  const html = renderCard(<ToolCard value={current} onRead={() => {}} />);
  expect(html).toContain('<span title="pnpm --filter pwa test:unit">pnpm --filter pwa test:unit</span>');
  expect(html).not.toContain("$ pnpm");
  expect(html).not.toContain("3 passed");
  expect(en.tools.viewDetails("bash")).toBe("View bash tool details");
  expect(zh.tools.viewDetails("bash")).toBe("查看 bash 工具详情");
});

test("group heading retains collapse semantics with a trailing chevron and no group status", () => {
  const html = renderCard(<ToolGroupCard values={[value, { ...value, tool_call_id: "second" }]} expanded={false} onExpandedChange={() => {}}>{null}</ToolGroupCard>);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("aria-controls=");
  expect(html.indexOf("pwa-tool-group-summary")).toBeLessThan(html.indexOf("pwa-tool-chevron"));
  expect(html).not.toContain('role="status"');
  expect(html).not.toContain("lucide-check");
});

test.each([[en, "1 failed", "2 failed"], [zh, "1 项失败", "2 项失败"]] as const)("group summary appends the failure count only when tools failed or were interrupted", (messages, one, two) => {
  const read = { ...base, tool: "read", args: { path: "a.ts" }, status: "complete" as const, result: "ok" };
  const failed = { ...base, tool: "bash", args: { command: "pnpm test" }, status: "error" as const, error: "failed" };
  const interrupted = { ...base, tool: "bash", args: { command: "pnpm test" }, status: "interrupted" as const };
  expect(toolGroupSummary([read, read], messages.tools)).not.toMatch(/失败|failed/);
  expect(toolGroupSummary([read, failed], messages.tools).endsWith(` · ${one}`)).toBe(true);
  expect(toolGroupSummary([read, failed, interrupted], messages.tools).endsWith(` · ${two}`)).toBe(true);
});
