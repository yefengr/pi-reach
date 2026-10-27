import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { ToolPreview } from "./tool-preview";
import { ToolReader } from "./tool-reader";
import { TOOL_INLINE_IMAGE_MAX_HEIGHT, toolHasOverflow, type ToolValue } from "./tool-presentation";
import { AttachmentCards } from "./attachment-cards";
import { QueuedMessages } from "./queued-messages";

const base = {
  event_id: "event", session_id: "session", leaf_id: "history", group_id: "group", timestamp: 0,
  kind: "tool" as const, tool_call_id: "call", tool: "read", args: { path: "notes.txt" }, status: "complete" as const, truncated: false,
};

function value(result: string): ToolValue {
  return { ...base, result };
}

afterEach(async () => { await page.viewport(1280, 900); });

test.each([1280, 390])("content images stay 8px and small thumbnails stay 4px at width %s", async width => {
  await page.viewport(width, 844);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const data = canvas.toDataURL("image/jpeg").split(",")[1];
  const current: ToolValue = { ...base, result: [{ type: "image", mimeType: "image/jpeg", data }] };
  function Harness() {
    const [opened, setOpened] = useState(false);
    return <>
      <ToolPreview value={current} />
      <AttachmentCards items={[{ id: "thumbnail", fileName: "thumbnail.jpg", byteLength: atob(data).length, status: "draft", preview: { mime_type: "image/jpeg", data, byte_length: atob(data).length, width: 32, height: 32 } }]} />
      <QueuedMessages items={[{ id: "queued", text: "Queued image fixture", images: [{ mime: "image/jpeg", data }], status: "Queued", canManage: false }]} isOnline={false} onInsert={() => {}} onCancel={() => {}} />
      <button type="button" onClick={() => setOpened(true)}>Open image fixture</button>
      <ToolReader value={current} opened={opened} onClose={() => setOpened(false)} />
    </>;
  }
  const screen = await renderPwa(<Harness />);
  const previousScheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  try {
    const content = document.querySelector<HTMLImageElement>(".pwa-tool-preview img")!;
    const thumbnail = document.querySelector<HTMLImageElement>("img.pwa-attachment-thumb")!;
    const queued = document.querySelector<HTMLImageElement>(".pwa-queued-message-images img")!;
    await expect.poll(() => [content, thumbnail, queued].every(image => image.complete && image.naturalWidth > 0)).toBe(true);
    for (const scheme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
      expect(getComputedStyle(content).borderRadius).toBe("8px");
      expect(getComputedStyle(content).maxHeight).toBe(`${TOOL_INLINE_IMAGE_MAX_HEIGHT}px`);
      expect(getComputedStyle(thumbnail).borderRadius).toBe("4px");
      expect(getComputedStyle(queued).borderRadius).toBe("4px");
      expect(Math.round(thumbnail.getBoundingClientRect().width)).toBe(32);
      expect(Math.round(queued.getBoundingClientRect().width)).toBe(24);
      await screen.getByRole("button", { name: "Open image fixture" }).click();
      await expect.element(screen.getByRole("dialog")).toBeVisible();
      const readerImage = document.querySelector<HTMLImageElement>(".pwa-tool-reader img")!;
      await expect.poll(() => readerImage.complete && readerImage.naturalWidth > 0).toBe(true);
      expect(getComputedStyle(readerImage).borderRadius).toBe("8px");
      expect(getComputedStyle(readerImage).maxHeight).toBe("none");
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => document.querySelector(".pwa-tool-reader")).toBeNull();
      await expect.poll(() => window.history.state?.piReachToolReader === true).toBe(false);
    }
  } finally {
    if (previousScheme === null) document.documentElement.removeAttribute("data-mantine-color-scheme");
    else document.documentElement.setAttribute("data-mantine-color-scheme", previousScheme);
    await screen.unmount();
  }
});

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

test("the reader shows the call as the first body block on the main background", async () => {
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
    // 参数原样列出且不截断：文字全部在块内，没有被裁切。
    expect(call.textContent).toBe(`command: ${command}`);
    expect(call.scrollHeight).toBeLessThanOrEqual(call.clientHeight);
    expect(body.textContent).not.toContain("$ pnpm");
    expect(body.textContent).toContain("3 passed");
    // 顶栏与正文同用主界面底色，状态栏与主界面一致；调用行与输出之间是 1px line 分割线。
    const probe = document.createElement("div");
    probe.style.background = "var(--pwa-bg)";
    probe.style.borderColor = "var(--pwa-line)";
    document.querySelector(".pwa-root")!.append(probe);
    const main = getComputedStyle(probe).backgroundColor;
    const line = getComputedStyle(probe).borderTopColor;
    probe.remove();
    expect(getComputedStyle(call).borderBottomWidth).toBe("1px");
    expect(getComputedStyle(call).borderBottomColor).toBe(line);
    const output = call.nextElementSibling!.getBoundingClientRect();
    expect(output.top).toBeGreaterThan(call.getBoundingClientRect().bottom);
    for (const element of [header, body, document.querySelector<HTMLElement>(".pwa-tool-reader")!]) {
      expect(getComputedStyle(element).backgroundColor).toBe(main);
    }
  } finally {
    await screen.unmount();
  }
});

test("reader output has no line numbers and shares the call line's left edge", async () => {
  const current: ToolValue = { ...base, args: { path: "notes.txt", offset: 20, limit: 2 }, result: [{ type: "text", text: "alpha\nbeta" }] };
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    const call = document.querySelector<HTMLElement>(".pwa-tool-reader-command")!;
    const output = document.querySelector<HTMLElement>(".pwa-reader-text")!;
    // 与 Pi 原生一致不带行号：正文即原始输出。
    expect(output.textContent).toBe("alpha\nbeta");
    expect(Math.round(output.getBoundingClientRect().left)).toBe(Math.round(call.getBoundingClientRect().left));
  } finally {
    await screen.unmount();
  }
});

test("the reader call line fills its first line before wrapping a hyphenated path", async () => {
  await page.viewport(390, 844);
  const path = "docs/plans/active/20260824-pwa-hardening.md";
  const current: ToolValue = { ...base, args: { path, offset: 1, limit: 60 }, result: [{ type: "text", text: "body" }] };
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    const call = document.querySelector<HTMLElement>(".pwa-tool-reader-command")!;
    const range = document.createRange();
    range.selectNodeContents(call);
    // 参数名与值是不同元素，同一行会返回多个矩形：按首行最高边取最右一个再比较。
    const rects = [...range.getClientRects()];
    expect(rects.length).toBeGreaterThan(1);
    const firstTop = Math.min(...rects.map(rect => Math.round(rect.top)));
    const firstLineRight = Math.max(...rects.filter(rect => Math.round(rect.top) === firstTop).map(rect => rect.right));
    // 首行排到距右缘不足一个字符宽才换行，不在 "pwa-" 的连字符处提前断开。
    const character = document.createRange();
    const firstText = document.createTreeWalker(call, NodeFilter.SHOW_TEXT).nextNode() as Text;
    character.setStart(firstText, 0);
    character.setEnd(firstText, 1);
    // 按整像素比较，避免 Linux CI 字体栅格化带来的亚像素差异。
    const characterWidth = Math.ceil(character.getBoundingClientRect().width);
    expect(Math.round(call.getBoundingClientRect().right - firstLineRight)).toBeLessThanOrEqual(characterWidth);
  } finally {
    await screen.unmount();
  }
});

test("every tool lists its arguments as is in the first block, without duplicating them in the body", async () => {
  const cases: { tool: string; args: Record<string, string | boolean | number>; expected?: string }[] = [
    { tool: "deploy", args: { target: "prod", force: true }, expected: "target: prod\nforce: true" },
    { tool: "read", args: { path: "read", offset: 20, limit: 10 }, expected: "path: read\noffset: 20\nlimit: 10" },
    { tool: "bash", args: { command: "build", cwd: "/tmp" }, expected: "command: build\ncwd: /tmp" },
    { tool: "status", args: {} },
    // 写入内容只在参数中出现一次，正文只放真实结果。
    { tool: "write", args: { path: "a.txt", content: "FILE BODY" }, expected: "path: a.txt\ncontent: FILE BODY" },
  ];
  for (const { tool, args, expected } of cases) {
    const current: ToolValue = { ...base, tool, args, result: [{ type: "text", text: "ok" }] };
    const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
    try {
      await expect.element(screen.getByRole("dialog", { name: tool, exact: true })).toBeVisible();
      const call = document.querySelector<HTMLElement>(".pwa-tool-reader-command");
      expect(call?.textContent).toBe(expected);
      if (call) expect(call).toBe(document.querySelector(".pwa-tool-reader-scroll")!.firstElementChild);
      const body = document.querySelector(".pwa-tool-reader-scroll")!.textContent ?? "";
      expect(body).not.toContain('"target"');
      expect(body.split("FILE BODY").length).toBeLessThanOrEqual(2);
    } finally {
      await screen.unmount();
    }
  }
});

test("the desktop reader header is a left-aligned tool name with status and close on the right", async () => {
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
    // 状态图标与关闭按钮之间只由 actions 的 6px gap 负责，图标自身不再叠加 margin。
    expect(getComputedStyle(status).gap).toBe("6px");
    expect(getComputedStyle(status).marginRight).toBe("0px");
    expect(getComputedStyle(document.querySelector<HTMLElement>(".pwa-tool-reader-actions")!).gap).toBe("6px");
    expect(document.querySelector(".pwa-tool-reader-actions .pwa-tool-reader-close")).not.toBeNull();
    expect(document.querySelector(".pwa-topbar-back")).toBeNull();
    expect(getComputedStyle(document.querySelector(".pwa-tool-reader")!).borderRadius).toBe("0px");
  } finally {
    await screen.unmount();
  }
});

test("the mobile full-screen reader stays square while it slides", async () => {
  await page.viewport(390, 844);
  const current: ToolValue = { ...base, tool: "bash", args: { command: "pnpm test" }, result: [{ type: "text", text: "3 passed" }] };
  let setOpened: (opened: boolean) => void = () => {};
  function Harness() {
    const [opened, update] = useState(false);
    setOpened = update;
    return <ToolReader value={current} opened={opened} onClose={() => update(false)} />;
  }
  const screen = await renderPwa(<Harness />);
  const reader = () => document.querySelector<HTMLElement>(".pwa-tool-reader");
  try {
    flushSync(() => setOpened(true));
    await expect.poll(reader).not.toBeNull();
    expect(reader()!.hasAttribute("data-pwa-moving")).toBe(true);
    expect(getComputedStyle(reader()!).borderRadius).toBe("0px");
    await expect.poll(() => reader()!.hasAttribute("data-pwa-moving")).toBe(false);
    expect(getComputedStyle(reader()!).borderRadius).toBe("0px");
    flushSync(() => setOpened(false));
    expect(reader()!.hasAttribute("data-pwa-moving")).toBe(true);
    expect(getComputedStyle(reader()!).borderRadius).toBe("0px");
    await expect.poll(reader).toBeNull();
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

test("the desktop reader adds the right safe area outside its 720px content and mobile insets both sides", async () => {
  document.documentElement.style.setProperty("--pwa-safe-left", "30px");
  document.documentElement.style.setProperty("--pwa-safe-right", "47px");
  try {
    await page.viewport(1280, 900);
    let screen = await renderPwa(<ToolReader value={value("done")} opened onClose={() => {}} />);
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    const content = document.querySelector<HTMLElement>(".mantine-Drawer-content")!;
    await expect.poll(() => Math.round(content.getBoundingClientRect().width)).toBe(720 + 47);
    expect(getComputedStyle(document.querySelector(".pwa-tool-reader-header")!).paddingRight).toBe(`${8 + 47}px`);
    expect(getComputedStyle(document.querySelector(".pwa-tool-reader-scroll")!).paddingRight).toBe(`${20 + 47}px`);
    expect(getComputedStyle(document.querySelector(".pwa-tool-reader-scroll")!).paddingLeft).toBe("20px");
    await screen.unmount();
    await page.viewport(740, 360);
    document.documentElement.style.setProperty("--pwa-safe-bottom", "34px");
    screen = await renderPwa(<ToolReader value={value("done")} opened onClose={() => {}} />);
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    const header = getComputedStyle(document.querySelector(".pwa-tool-reader-header")!);
    expect([header.paddingLeft, header.paddingRight]).toEqual([`${4 + 30}px`, `${4 + 47}px`]);
    const scroll = getComputedStyle(document.querySelector(".pwa-tool-reader-scroll")!);
    expect([scroll.paddingLeft, scroll.paddingRight]).toEqual([`${16 + 30}px`, `${16 + 47}px`]);
    // 全屏阅读器底部取 16 与底部安全区中的较大值，末尾内容不进入安全区。
    expect(scroll.paddingBottom).toBe("34px");
    await screen.unmount();
  } finally {
    document.documentElement.style.removeProperty("--pwa-safe-left");
    document.documentElement.style.removeProperty("--pwa-safe-right");
    document.documentElement.style.removeProperty("--pwa-safe-bottom");
    await page.viewport(1280, 900);
  }
});
