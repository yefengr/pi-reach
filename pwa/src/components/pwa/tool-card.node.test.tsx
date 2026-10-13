import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PwaUiProvider } from "./pwa-ui-provider";
import { ToolCard, ToolGroupCard, toolGroupSummary } from "./tool-card";
import { toolIdentity, type ToolStatus, type ToolValue } from "./tool-presentation";
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
  expect(html).toContain('<span title="pnpm --filter pwa test:unit">pnpm --filter pwa test:unit</span>');
  expect(html).not.toContain("$ pnpm");
  expect(html).not.toContain("3 passed");
  expect(en.tools.viewDetails("bash")).toBe("View bash tool details");
  expect(zh.tools.viewDetails("bash")).toBe("查看 bash 工具详情");
});

test("group heading retains collapse semantics with a trailing chevron and no group status", () => {
  const html = renderCard(<ToolGroupCard values={[value, { ...value, tool_call_id: "second" }]} live expanded={false} onExpandedChange={() => {}}>{null}</ToolGroupCard>);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("aria-controls=");
  expect(html.indexOf("pwa-tool-group-summary")).toBeLessThan(html.indexOf("pwa-tool-chevron"));
  expect(html).not.toContain('role="status"');
  expect(html).not.toContain("lucide-check");
});

const groupRead = { ...base, tool: "read", args: { path: "a.ts" }, status: "complete" as const, result: "ok" };
const groupFailed = { ...base, tool: "bash", args: { command: "pnpm test" }, status: "error" as const, error: "failed" };
const groupInterrupted = { ...base, tool: "bash", args: { command: "pnpm test" }, status: "interrupted" as const };

test.each([[en, "1 failed", "2 failed", "1 interrupted"], [zh, "1 项失败", "2 项失败", "1 项已中断"]] as const)("group summary counts failures and interruptions separately", (messages, one, two, interrupted) => {
  expect(toolGroupSummary([groupRead, groupRead], messages.tools)).not.toMatch(/失败|中断|failed|interrupted/);
  expect(toolGroupSummary([groupRead, groupFailed], messages.tools).endsWith(` · ${one}`)).toBe(true);
  expect(toolGroupSummary([groupRead, groupFailed, groupFailed], messages.tools).endsWith(` · ${two}`)).toBe(true);
  expect(toolGroupSummary([groupRead, groupInterrupted], messages.tools).endsWith(` · ${interrupted}`)).toBe(true);
  expect(toolGroupSummary([groupRead, groupInterrupted], messages.tools)).not.toMatch(/失败|failed/);
  expect(toolGroupSummary([groupRead, groupFailed, groupInterrupted], messages.tools).endsWith(` · ${one} · ${interrupted}`)).toBe(true);
});

test("interrupted tools use a stop icon and only failures raise the group alert", () => {
  const interrupted = renderCard(<ToolCard value={fixtures.interrupted} onRead={() => {}} />);
  expect(interrupted).toContain("lucide-circle-stop");
  expect(interrupted).not.toContain("lucide-circle-alert");
  expect(renderCard(<ToolCard value={fixtures.error} onRead={() => {}} />)).toContain("lucide-circle-alert");
  const group = (values: ToolValue[]) => renderCard(<ToolGroupCard values={values} live expanded={false} onExpandedChange={() => {}}>{null}</ToolGroupCard>);
  expect(group([groupRead, groupInterrupted])).not.toContain("pwa-tool-group-alert");
  expect(group([groupRead, groupFailed, groupInterrupted])).toContain("pwa-tool-group-alert");
});

const runningTool = (id: string, command: string): ToolValue => ({
  protocol_version: 2, type: "timeline_partial", session_id: "session", leaf_id: "generation", group_id: "group",
  kind: "tool", partial_id: `tool:${id}`, tool_call_id: id, tool: "bash", args: { command }, status: "running",
});
const doneTool = (id: string, command: string): ToolValue => ({ ...base, tool_call_id: id, tool: "bash", args: { command }, status: "complete", result: "ok" });
const groupHead = (values: ToolValue[], { live = true, expanded = false } = {}) => renderCard(<ToolGroupCard values={values} live={live} expanded={expanded} onExpandedChange={() => {}}>{null}</ToolGroupCard>);

test("collapsed group heading shows the last started tool while it runs", () => {
  const html = groupHead([doneTool("lint", "pnpm lint"), runningTool("test", "pnpm test")]);
  expect(html).toContain("pwa-tool-group-current");
  expect(html).toContain('<span title="pnpm test">pnpm test</span>');
  expect(html).not.toContain("pwa-tool-group-summary");
  expect(html).toContain('aria-label="Expand Running bash pnpm test · Ran 2 commands"');
  expect(zh.tools.groupRunning("bash pnpm test")).toBe("正在运行 bash pnpm test");
});

test.each(["running", "complete", "error", "interrupted"] as const)("a newly appended %s tool keeps text, status and chevron in DOM order", status => {
  const current: ToolValue = {
    running: runningTool("test", "pnpm test"), complete: doneTool("test", "pnpm test"),
    error: { ...groupFailed, tool_call_id: "test" }, interrupted: { ...groupInterrupted, tool_call_id: "test" },
  }[status];
  const html = renderCard(<ToolGroupCard values={[current]} live appended={new Set([toolIdentity(current)])} expanded={false} onExpandedChange={() => {}}>{null}</ToolGroupCard>);
  const copy = html.indexOf('class="pwa-tool-action-copy"');
  const statusNode = html.indexOf(`class="pwa-tool-group-status pwa-tool-status pwa-tool-status-${status}"`);
  const chevron = html.indexOf("pwa-tool-chevron");
  expect(copy).toBeGreaterThan(-1);
  expect(statusNode).toBeGreaterThan(copy);
  expect(chevron).toBeGreaterThan(statusNode);
  expect(html.slice(copy, statusNode)).toContain('<strong title="bash">bash</strong><span title="pnpm test">pnpm test</span>');
  expect(html.slice(copy, statusNode)).not.toContain("<svg");
  expect(html).not.toContain('role="status"');
  expect(html).not.toContain("data-enter");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("aria-controls=");
  const currentLabel = status === "running" ? en.tools.groupRunning("bash pnpm test") : en.tools.statusLabel("bash pnpm test", en.tools.status[status]);
  expect(html).toContain(`aria-label="${en.tools.groupToggle(false, `${currentLabel} · ${toolGroupSummary([current], en.tools)}`)}"`);
  if (status === "error") {
    expect(html.match(/lucide-circle-alert/g)).toHaveLength(1);
    expect(html).not.toContain("pwa-tool-group-alert");
  }
});

test("a previous failure retains its right-side alert beside a different current tool", () => {
  const html = groupHead([groupFailed, runningTool("test", "pnpm test")]);
  expect(html.indexOf("pwa-tool-group-status")).toBeLessThan(html.indexOf("pwa-tool-group-alert"));
  expect(html.indexOf("pwa-tool-group-alert")).toBeLessThan(html.indexOf("pwa-tool-chevron"));
  expect(html.match(/lucide-circle-alert/g)).toHaveLength(1);
});

test("a heading first rendered mid-run shows the last running tool, and a finished group shows only the summary", () => {
  const html = groupHead([runningTool("test", "pnpm test"), doneTool("build", "pnpm build")]);
  expect(html).toContain('<span title="pnpm test">pnpm test</span>');
  const finished = groupHead([doneTool("test", "pnpm test"), doneTool("build", "pnpm build")]);
  expect(finished).not.toContain("pwa-tool-group-current");
  expect(finished).not.toContain("pwa-spin");
  expect(finished).not.toContain("pwa-tool-group-status");
  expect(finished).not.toContain("lucide-check");
});

test("expanded or offline groups show only the summary", () => {
  const expanded = groupHead([runningTool("test", "pnpm test")], { expanded: true });
  expect(expanded).not.toContain("pwa-tool-group-current");
  expect(expanded).not.toContain("pwa-spin");
  expect(expanded).not.toContain("pwa-tool-group-status");
  expect(expanded).not.toContain("lucide-check");
  // 离线时 partial 状态未知，不作为当前工具，也不显示旋转图标。
  const offline = groupHead([runningTool("test", "pnpm test")], { live: false });
  expect(offline).not.toContain("pwa-tool-group-current");
  expect(offline).not.toContain("pwa-spin");
});
