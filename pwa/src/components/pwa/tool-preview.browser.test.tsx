import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { ToolPreview } from "./tool-preview";
import { ToolReader } from "./tool-reader";
import { toolHasOverflow, type ToolValue } from "./tool-presentation";

const base = {
  event_id: "event", session_id: "session", leaf_id: "history", group_id: "group", timestamp: 0,
  kind: "tool" as const, tool_call_id: "call", tool: "read", args: { path: "notes.txt" }, status: "complete" as const, truncated: false,
};

function value(result: string): ToolValue {
  return { ...base, result };
}

afterEach(async () => { await page.viewport(1280, 900); });

test("View all follows logical and measured overflow through streaming changes", async () => {
  await page.viewport(390, 844);
  const short = "Complete output.";
  const long = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  expect(toolHasOverflow(value(long))).toBe(true);
  let setOutput!: (output: string) => void;
  function Harness() {
    const [output, setValue] = useState(short);
    setOutput = setValue;
    return <main style={{ width: "100vw" }}><ToolPreview value={value(output)} onRead={() => {}} /></main>;
  }

  const screen = await renderPwa(<Harness />);
  await expect.poll(() => document.querySelector(".pwa-tool-details-button")).toBeNull();
  expect(document.querySelector(".pwa-tool-preview")!.hasAttribute("data-overflow")).toBe(false);

  flushSync(() => setOutput(long));
  await expect.poll(() => document.querySelector(".pwa-tool-details-button")).not.toBeNull();
  const preview = document.querySelector<HTMLElement>(".pwa-tool-preview")!;
  const button = screen.getByRole("button", { name: "View all (20 lines)" }).element();
  expect(preview.hasAttribute("data-overflow")).toBe(true);
  expect(preview.getBoundingClientRect().height).toBeLessThan(document.querySelector(".pwa-tool-preview-content")!.getBoundingClientRect().height);
  expect(getComputedStyle(preview).overflowY).toBe("clip");
  preview.scrollTop = 100;
  expect(preview.scrollTop).toBe(0);
  for (const descendant of preview.querySelectorAll<HTMLElement>("*")) {
    expect(getComputedStyle(descendant).overflowY).not.toMatch(/auto|scroll/);
  }
  expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(32);

  flushSync(() => setOutput(short));
  await expect.poll(() => document.querySelector(".pwa-tool-details-button")).toBeNull();
  expect(document.body.textContent).not.toContain("Raw data");
});

test("all output blocks share one height limit while host truncation stays visible", async () => {
  const current: ToolValue = {
    ...base, truncated: true,
    result: Array.from({ length: 6 }, (_, index) => ({ type: "text", text: `Block ${index}\nSecond line` })),
  };
  expect(toolHasOverflow(current)).toBe(false);
  const screen = await renderPwa(<ToolPreview value={current} onRead={() => {}} />);
  await expect.element(screen.getByRole("button", { name: /^View all/ })).toBeVisible();
  const preview = document.querySelector<HTMLElement>(".pwa-tool-preview")!;
  expect(preview.querySelectorAll("pre")).toHaveLength(6);
  expect(document.querySelector(".pwa-tool-preview-content")!.getBoundingClientRect().height).toBeGreaterThan(preview.getBoundingClientRect().height);
  const notice = screen.getByText("Output was truncated by the host.");
  await expect.element(notice).toBeVisible();
  expect(preview.contains(notice.element())).toBe(false);
  expect(notice.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(preview.getBoundingClientRect().bottom);
});

test("command preview echoes the call as its first line inside the bounded preview", async () => {
  const command = "pnpm --filter pwa test:unit";
  const current: ToolValue = { ...base, tool: "bash", args: { command }, result: [{ type: "text", text: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") }] };
  const screen = await renderPwa(<ToolPreview value={current} onRead={() => {}} />);
  const blocks = document.querySelectorAll<HTMLElement>(".pwa-tool-preview .pwa-tool-output-blocks > *");
  expect(blocks[0]?.textContent).toBe(`$ ${command}`);
  expect(document.querySelector(".pwa-tool-preview")!.hasAttribute("data-overflow")).toBe(true);
  await expect.element(screen.getByRole("button", { name: "View all (20 lines)" })).toBeVisible();
});

test.each([
  { name: "desktop", width: 1280, height: 900, readerWidth: 720 },
  { name: "mobile", width: 390, height: 844, readerWidth: 390 },
])("the $name reader docks to the right edge at full height", async ({ width, height, readerWidth }) => {
  await page.viewport(width, height);
  const screen = await renderPwa(<ToolReader value={value("done")} opened onClose={() => {}} />);
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  const content = document.querySelector<HTMLElement>(".mantine-Drawer-content")!;
  await expect.poll(() => Math.round(content.getBoundingClientRect().width)).toBe(readerWidth);
  const rect = content.getBoundingClientRect();
  expect(Math.round(rect.right)).toBe(width);
  expect(Math.round(rect.top)).toBe(0);
  expect(Math.round(rect.height)).toBe(height);
  const inner = document.querySelector<HTMLElement>(".mantine-Drawer-inner")!;
  expect(inner.classList.contains("pwa-tool-reader")).toBe(false);
  expect(getComputedStyle(inner).flexDirection).toBe("row");
});

test("the reader keeps the full call in its header instead of repeating it in the numbered body", async () => {
  const command = "pnpm --filter pwa test:unit";
  const current: ToolValue = { ...base, tool: "bash", args: { command }, result: [{ type: "text", text: "3 passed" }] };
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await expect.element(screen.getByText(command)).toBeVisible();
  const body = document.querySelector(".pwa-tool-reader-scroll")!;
  expect(body.textContent).not.toContain("$ pnpm");
  expect(body.textContent).toContain("3 passed");
});

test("the reader header reads like the tool row: tool and command first, status beside the actions", async () => {
  const command = "pnpm --filter pwa test:unit";
  const current: ToolValue = { ...base, tool: "bash", args: { command }, result: [{ type: "text", text: "3 passed" }] };
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    const title = document.querySelector<HTMLElement>(".pwa-tool-reader-title")!;
    const tool = title.querySelector<HTMLElement>(".pwa-tool-reader-tool")!;
    const heading = title.querySelector<HTMLElement>(".pwa-tool-reader-command")!;
    expect(tool.textContent).toBe("bash");
    expect(heading.textContent).toBe(command);
    // 工具名在命令左侧同一行；状态不在标题里，而是放在右侧操作区。
    expect(tool.getBoundingClientRect().right).toBeLessThanOrEqual(heading.getBoundingClientRect().left);
    expect(title.querySelector(".pwa-tool-reader-status")).toBeNull();
    const status = document.querySelector<HTMLElement>(".pwa-tool-reader-actions .pwa-tool-reader-status")!;
    expect(status.textContent).toBe("Complete");
    expect(status.getBoundingClientRect().left).toBeGreaterThanOrEqual(title.getBoundingClientRect().right);
  } finally {
    await screen.unmount();
  }
});

test("the desktop reader header clears a translucent status bar", async () => {
  const safeTop = 24;
  await page.viewport(1024, 768);
  document.documentElement.style.setProperty("--pwa-safe-top", `${safeTop}px`);
  try {
    const screen = await renderPwa(<ToolReader value={value("done")} opened onClose={() => {}} />);
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    const header = document.querySelector<HTMLElement>(".pwa-tool-reader-header")!;
    // 阅读器贯通全高，顶栏内容在安全区之下仍保留原有 12px 上边距。
    const children = [...header.children].filter(child => child.getBoundingClientRect().height > 0);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) expect(Math.round(child.getBoundingClientRect().top), child.className).toBeGreaterThanOrEqual(safeTop + 12);
  } finally {
    document.documentElement.style.removeProperty("--pwa-safe-top");
  }
});
