import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PwaUiProvider } from "./pwa-ui-provider";
import { ToolCard } from "./tool-card";
import { processGroupSummary } from "./process-group-state";
import type { Messages } from "@/lib/i18n";
import type { ToolStatus } from "./tool-presentation";
import type { TimelineToolValue as ToolValue } from "@/lib/pwa/timeline-presentation";
import { en } from "@/lib/i18n/messages/en";
import { zh } from "@/lib/i18n/messages/zh";

/** 纯工具组的分类摘要：不传成员状态时按各工具自身状态统计，与生产组头同一入口。 */
const toolSummary = (values: readonly ToolValue[], t: Messages["tools"]) => processGroupSummary(
  { key: "summary", groupId: "summary", entries: values.map((value, index) => ({ kind: "tool" as const, key: `tool-${index}`, value })) }, new Map(), t,
).fullLabel;
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
  const copy = html.indexOf('class="pwa-tool-action-copy"');
  const statusNode = html.indexOf(`class="pwa-tool-status pwa-tool-status-${status}"`);
  expect(copy).toBeLessThan(statusNode);
  expect(html.slice(copy, statusNode)).not.toContain("<svg");
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
  expect(html).toContain('<strong class="pwa-tool-verb" title="bash">Run</strong>');
  // 无法分类的工具保留原始工具名，不当作动词处理。
  expect(renderCard(<ToolCard value={{ ...base, tool: "deploy", args: { target: "prod" }, status: "complete", result: "ok" }} onRead={() => {}} />)).toContain('<strong title="deploy">deploy</strong>');
  expect(html).toContain('<span class="pwa-tool-target" title="pnpm --filter pwa test:unit">pnpm --filter pwa test:unit</span>');
  expect(html).not.toContain("$ pnpm");
  expect(html).not.toContain("3 passed");
  expect(en.tools.viewDetails("bash")).toBe("View bash tool details");
  expect(zh.tools.viewDetails("bash")).toBe("查看 bash 工具详情");
});

const groupRead = { ...base, tool: "read", args: { path: "a.ts" }, status: "complete" as const, result: "ok" };
const groupFailed = { ...base, tool: "bash", args: { command: "pnpm test" }, status: "error" as const, error: "failed" };
const groupInterrupted = { ...base, tool: "bash", args: { command: "pnpm test" }, status: "interrupted" as const };

test.each([[en, "1 failed", "2 failed", "1 interrupted"], [zh, "1 项失败", "2 项失败", "1 项已中断"]] as const)("group summary counts failures and interruptions separately", (messages, one, two, interrupted) => {
  expect(toolSummary([groupRead, groupRead], messages.tools)).not.toMatch(/失败|中断|failed|interrupted/);
  expect(toolSummary([groupRead, groupFailed], messages.tools).endsWith(` · ${one}`)).toBe(true);
  expect(toolSummary([groupRead, groupFailed, groupFailed], messages.tools).endsWith(` · ${two}`)).toBe(true);
  expect(toolSummary([groupRead, groupInterrupted], messages.tools).endsWith(` · ${interrupted}`)).toBe(true);
  expect(toolSummary([groupRead, groupInterrupted], messages.tools)).not.toMatch(/失败|failed/);
  expect(toolSummary([groupRead, groupFailed, groupInterrupted], messages.tools).endsWith(` · ${one} · ${interrupted}`)).toBe(true);
});

test("interrupted tools use a stop icon and failures use an alert", () => {
  const interrupted = renderCard(<ToolCard value={fixtures.interrupted} onRead={() => {}} />);
  expect(interrupted).toContain("lucide-circle-stop");
  expect(interrupted).not.toContain("lucide-circle-alert");
  expect(renderCard(<ToolCard value={fixtures.error} onRead={() => {}} />)).toContain("lucide-circle-alert");
});

test.each([
  ["read", { path: "a.ts" }, "lucide-eye"],
  ["bash", { command: "pnpm test" }, "lucide-terminal"],
  ["grep", { pattern: "needle" }, "lucide-search"],
  ["edit", { path: "a.ts" }, "lucide-file-diff"],
  ["write", { path: "a.ts" }, "lucide-pencil"],
  ["deploy", { target: "prod" }, "lucide-wrench"],
] as const)("a completed %s call shows its type icon instead of a check", (tool, args, icon) => {
  const html = renderCard(<ToolCard value={{ ...base, tool, args, status: "complete", result: "ok" }} onRead={() => {}} />);
  expect(html).toContain(icon);
  expect(html).not.toContain("lucide-check");
  // 运行中仍换成旋转图标，类型图标不与状态图标并存。
  const running = renderCard(<ToolCard value={{ ...base, tool, args, status: "complete", result: "ok" }} status="running" onRead={() => {}} />);
  expect(running).toContain("lucide-loader-circle");
  expect(running).not.toContain(icon);
});

test("edit rows show returned diff line counts and nothing without a returned diff", () => {
  const html = renderCard(<ToolCard value={value} onRead={() => {}} />);
  expect(html).toContain('<span class="pwa-tool-diff" title="1 line added, 1 removed"><span class="pwa-tool-diff-add">+1</span><span class="pwa-tool-diff-remove">−1</span></span>');
  expect(renderCard(<ToolCard value={{ ...base, status: "complete", result: "Applied" }} onRead={() => {}} />)).not.toContain("pwa-tool-diff");
  expect(zh.tools.diffStats(12, 3)).toBe("新增 12 行，删除 3 行");
});
