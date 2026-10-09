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

test("the reader shows the full call as the first body block, not in the header", async () => {
  const command = "pnpm --filter pwa test:unit --reporter=verbose --coverage --project browser --project node";
  const current: ToolValue = { ...base, tool: "bash", args: { command }, result: [{ type: "text", text: "3 passed" }] };
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    const header = document.querySelector<HTMLElement>(".pwa-tool-reader-header")!;
    expect(header.textContent).not.toContain(command);
    const body = document.querySelector<HTMLElement>(".pwa-tool-reader-scroll")!;
    const call = body.firstElementChild as HTMLElement;
    expect(call.matches(".pwa-tool-reader-command")).toBe(true);
    // 完整调用不截断：文字全部在块内，没有被裁切。
    expect(call.textContent).toBe(command);
    expect(call.scrollHeight).toBeLessThanOrEqual(call.clientHeight);
    expect(body.textContent).not.toContain("$ pnpm");
    expect(body.textContent).toContain("3 passed");
  } finally {
    await screen.unmount();
  }
});

test("the reader shows the call whenever arguments exist, even when the path equals the tool name", async () => {
  const cases: { args: { path: string; offset?: number; limit?: number }; expected: string[] }[] = [
    { args: { path: "read", offset: 20, limit: 10 }, expected: ["offset: 20", "limit: 10"] },
    // 没有额外参数时调用文本恰为 "read"，仍须显示被读取的路径。
    { args: { path: "read" }, expected: [] },
  ];
  for (const { args, expected } of cases) {
    const current: ToolValue = { ...base, args, result: [{ type: "text", text: "line 20" }] };
    const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
    try {
      await expect.element(screen.getByRole("dialog")).toBeVisible();
      const call = document.querySelector<HTMLElement>(".pwa-tool-reader-scroll")!.firstElementChild as HTMLElement;
      expect(call.matches(".pwa-tool-reader-command")).toBe(true);
      expect(call.textContent?.startsWith("read")).toBe(true);
      for (const text of expected) expect(call.textContent).toContain(text);
    } finally {
      await screen.unmount();
    }
  }
});

test("the reader omits the call block for a generic tool without arguments", async () => {
  const current: ToolValue = { ...base, tool: "status", args: {}, result: [{ type: "text", text: "ok" }] };
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByRole("dialog", { name: "status", exact: true })).toBeVisible();
    expect(document.querySelector(".pwa-tool-reader-command")).toBeNull();
  } finally {
    await screen.unmount();
  }
});

test("the desktop reader header is a left-aligned tool name with status, copy and close on the right", async () => {
  const command = "pnpm --filter pwa test:unit";
  const current: ToolValue = { ...base, tool: "bash", args: { command }, result: [{ type: "text", text: "3 passed" }] };
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    // 对话框以工具名为可访问名称。
    await expect.element(screen.getByRole("dialog", { name: "bash", exact: true })).toBeVisible();
    const header = document.querySelector<HTMLElement>(".pwa-tool-reader-header")!.getBoundingClientRect();
    const title = document.querySelector<HTMLElement>(".pwa-tool-reader-title")!;
    expect(title.textContent).toBe("bash");
    expect(getComputedStyle(title).fontSize).toBe("18px");
    // 标题靠左，从 20px 左边距开始，不水平居中。
    expect(Math.round(title.getBoundingClientRect().left - header.left)).toBe(20);
    expect(title.querySelector(".pwa-tool-reader-status")).toBeNull();
    const status = document.querySelector<HTMLElement>(".pwa-tool-reader-actions .pwa-tool-reader-status")!;
    // 与会话内工具行一致只显示图标：文字仍供读屏，但不占可见宽度。
    expect(status.textContent).toBe("Complete");
    expect(Math.round(status.getBoundingClientRect().width)).toBe(16);
    expect(status.getBoundingClientRect().left).toBeGreaterThanOrEqual(title.getBoundingClientRect().right);
    expect(document.querySelector(".pwa-tool-reader-actions .pwa-tool-reader-close")).not.toBeNull();
    expect(document.querySelector(".pwa-topbar-back")).toBeNull();
  } finally {
    await screen.unmount();
  }
});

test("the mobile reader header starts with a back button like the settings top bar", async () => {
  await page.viewport(390, 844);
  const current: ToolValue = { ...base, tool: "bash", args: { command: "pnpm test" }, result: [{ type: "text", text: "3 passed" }] };
  const events: string[] = [];
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => events.push("close")} />);
  try {
    const back = screen.getByRole("button", { name: "Close tool details" });
    await expect.element(back).toBeVisible();
    const header = document.querySelector<HTMLElement>(".pwa-tool-reader-header")!;
    await expect.poll(() => Math.round(header.getBoundingClientRect().left)).toBe(0);
    expect(back.element().closest(".pwa-tool-reader-actions")).toBeNull();
    expect(header.firstElementChild).toBe(back.element());
    // 返回按钮距左缘 4px，标题与其相距 4px：与移动标题区、设置页同一位置。
    const backBox = back.element().getBoundingClientRect();
    expect(Math.round(backBox.left)).toBe(4);
    expect(Math.round(document.querySelector(".pwa-tool-reader-title")!.getBoundingClientRect().left)).toBe(52);
    expect(Math.round(header.getBoundingClientRect().height)).toBe(48);
    await back.click();
    expect(events).toEqual(["close"]);
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
    // 阅读器贯通全高，顶栏与会话标题区同为安全区之下 48px，关闭按钮垂直居中。
    const children = [...header.children].filter(child => child.getBoundingClientRect().height > 0);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) expect(Math.round(child.getBoundingClientRect().top), child.className).toBeGreaterThanOrEqual(safeTop);
    expect(Math.round(header.getBoundingClientRect().height)).toBe(48 + safeTop);
    const close = header.querySelector(".pwa-tool-reader-close")!.getBoundingClientRect();
    expect(Math.abs(close.top + close.height / 2 - (safeTop + 24))).toBeLessThanOrEqual(1);
  } finally {
    document.documentElement.style.removeProperty("--pwa-safe-top");
  }
});
