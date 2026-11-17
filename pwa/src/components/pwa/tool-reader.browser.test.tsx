import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { ToolReader } from "./tool-reader";
import type { ToolValue } from "./tool-presentation";
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

test.each([1280, 390])("reader images stay 12px and small thumbnails stay 4px at width %s", async width => {
  await page.viewport(width, 844);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const data = canvas.toDataURL("image/jpeg").split(",")[1];
  const current: ToolValue = { ...base, result: [{ type: "image", mimeType: "image/jpeg", data }] };
  function Harness() {
    const [opened, setOpened] = useState(false);
    return <>
      <AttachmentCards items={[{ id: "thumbnail", fileName: "thumbnail.jpg", byteLength: atob(data).length, status: "draft", preview: { mime_type: "image/jpeg", data, byte_length: atob(data).length, width: 32, height: 32 } }]} />
      <QueuedMessages items={[{ id: "queued", text: "Queued image fixture", images: [{ mime: "image/jpeg", data }], status: "Queued", canManage: false }]} isOnline={false} onInsert={() => {}} onCancel={() => {}} />
      <button type="button" onClick={() => setOpened(true)}>Open image fixture</button>
      <ToolReader value={current} opened={opened} onClose={() => setOpened(false)} />
    </>;
  }
  const screen = await renderPwa(<Harness />);
  const previousScheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  try {
    const thumbnail = document.querySelector<HTMLImageElement>("img.pwa-attachment-thumb")!;
    const queued = document.querySelector<HTMLImageElement>(".pwa-queued-message-images img")!;
    await expect.poll(() => [thumbnail, queued].every(image => image.complete && image.naturalWidth > 0)).toBe(true);
    for (const scheme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
      expect(getComputedStyle(thumbnail).borderRadius).toBe("4px");
      expect(getComputedStyle(queued).borderRadius).toBe("4px");
      expect(Math.round(thumbnail.getBoundingClientRect().width)).toBe(32);
      expect(Math.round(queued.getBoundingClientRect().width)).toBe(24);
      await screen.getByRole("button", { name: "Open image fixture" }).click();
      await expect.element(screen.getByRole("dialog")).toBeVisible();
      await expect.poll(() => {
        const image = document.querySelector<HTMLImageElement>(".pwa-tool-reader img");
        return image?.complete === true && image.naturalWidth > 0;
      }).toBe(true);
      const readerImage = document.querySelector<HTMLImageElement>(".pwa-tool-reader img")!;
      expect(getComputedStyle(readerImage).borderRadius).toBe("12px");
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

test("Run shows the original command and log on the shared background with separate copy actions", async () => {
  const command = "pnpm --filter pwa test:unit --reporter=verbose --coverage --project browser --project node";
  const current: ToolValue = { ...base, tool: "bash", args: { command, timeout: 30 }, result: [{ type: "text", text: "3 passed" }] };
  const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByRole("button", { name: "Copy command", exact: true })).toBeVisible();
    const body = document.querySelector<HTMLElement>(".pwa-tool-reader-scroll")!;
    const call = body.querySelector<HTMLElement>(".pwa-reader-command")!;
    expect(call.querySelector("pre")!.textContent).toBe(`$ ${command}`);
    expect(body.textContent).not.toContain("timeout:");
    expect(body.querySelector("details, .pwa-tool-reader-command")).toBeNull();
    expect(getComputedStyle(call).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(call).borderRadius).toBe("0px");
    expect(getComputedStyle(body).backgroundColor).toBe(getComputedStyle(document.querySelector(".pwa-tool-reader-header")!).backgroundColor);
    await screen.getByRole("button", { name: "Copy command", exact: true }).click();
    expect(copied).toHaveBeenLastCalledWith(command);
    await screen.getByRole("button", { name: "Copy log", exact: true }).click();
    expect(copied).toHaveBeenLastCalledWith("3 passed");
  } finally { copied.mockRestore(); await screen.unmount(); }
});

test.each(["pwa/src", undefined])("Search separates its term, real scope and matching results with scope %s", async scope => {
  await page.viewport(320, 740);
  const term = `TOOL_TYPE_ICONS ${"long-search-term-".repeat(16)}`;
  const output = "pwa/src/a.ts:12: TOOL_TYPE_ICONS\npwa/src/b.ts:4: TOOL_TYPE_ICONS";
  const current: ToolValue = { ...base, tool: "grep", args: { pattern: term, ...(scope ? { path: scope } : {}) }, result: [{ type: "text", text: output }] };
  const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    const search = document.querySelector<HTMLElement>(".pwa-reader-search")!;
    expect(search.querySelector(".pwa-reader-toolbar span")?.textContent).toBe(scope ? `Search · ${scope}` : "Search");
    expect(search.querySelector(".pwa-reader-text")?.textContent).toBe(term);
    expect(search.querySelector(".pwa-reader-file-path")).toBeNull();
    const result = document.querySelector<HTMLElement>(".pwa-reader-block")!;
    expect(result.querySelector(".pwa-reader-toolbar span")?.textContent).toBe("Matching results");
    expect(result.querySelector("pre")?.textContent).toBe(output);
    const body = document.querySelector<HTMLElement>(".pwa-tool-reader-scroll")!;
    expect(body.scrollWidth).toBe(body.clientWidth);
    await screen.getByRole("button", { name: "Copy search term", exact: true }).click();
    expect(copied).toHaveBeenLastCalledWith(term);
    await screen.getByRole("button", { name: "Copy search results", exact: true }).click();
    expect(copied).toHaveBeenLastCalledWith(output);
  } finally { copied.mockRestore(); await screen.unmount(); }
});

test("structured search results use the same matching-results section", async () => {
  const current: ToolValue = { ...base, tool: "grep", args: { pattern: "needle", path: "src" }, result: { matches: [{ path: "src/a.ts", line: 12, text: "needle" }] } };
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByRole("region", { name: "Matching results", exact: true })).toBeVisible();
    expect(document.querySelector(".pwa-reader-block pre")?.textContent).toContain("src/a.ts:12");
  } finally { await screen.unmount(); }
});

test("Edit without saved differences retains the confirmed title and explanatory empty state", async () => {
  const current: ToolValue = { ...base, tool: "edit", args: { path: "src/a.ts", oldText: "PRIVATE_OLD", newText: "PRIVATE_NEW" }, result: [{ type: "text", text: "Successfully replaced 1 block(s) in src/a.ts." }] };
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByRole("heading", { name: "No diff was returned for this operation", exact: true })).toBeVisible();
    await expect.element(screen.getByText("The details of this edit are not available.", { exact: true })).toBeVisible();
    const empty = document.querySelector<HTMLElement>(".pwa-reader-diff-empty")!;
    expect(getComputedStyle(empty).paddingTop).toBe("24px");
    expect(getComputedStyle(empty.querySelector("h2")!).fontWeight).toBe("600");
    expect(document.querySelector(".pwa-tool-reader-scroll")?.textContent).not.toMatch(/PRIVATE_|Successfully replaced/);
    expect(document.querySelector(".pwa-reader-diff")).toBeNull();
  } finally { await screen.unmount(); }
});

test.each([
  { tool: "read", offset: undefined, recognized: true },
  { tool: "read", offset: 41, recognized: false },
  { tool: "read", offset: 0, recognized: false },
  { tool: "write", offset: undefined, recognized: true },
])("Markdown frontmatter follows the real tool source origin: %j", async ({ tool, offset, recognized }) => {
  const text = "---\nname: example-skill\ndescription: metadata\n---\n\n# Body";
  const current: ToolValue = { ...base, tool, args: { path: "notes.md", ...(offset === undefined ? {} : { offset }), ...(tool === "write" ? { content: text } : {}) }, result: [{ type: "text", text: tool === "write" ? "Successfully wrote to notes.md" : text }] };
  const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await screen.getByRole("button", { name: "Preview", exact: true }).click();
    const body = document.querySelector(".pwa-tool-reader-scroll")!;
    expect(body.querySelector(".pwa-code-language")?.textContent === "yaml").toBe(recognized);
    expect(body.querySelector(".pwa-file-markdown hr") !== null).toBe(!recognized);
    expect(body.querySelector(".pwa-file-markdown h1")?.textContent).toBe("Body");
    await screen.getByRole("button", { name: "Copy content", exact: true }).click();
    expect(copied).toHaveBeenLastCalledWith(text);
  } finally { copied.mockRestore(); await screen.unmount(); }
});

test("Read shows actual file lines and copies only the returned source", async () => {
  const current: ToolValue = { ...base, args: { path: "notes.txt", offset: 20, limit: 100 }, result: [{ type: "text", text: "alpha\nbeta\n\n[3 more lines in file. Use offset=22 to continue.]" }] };
  const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByText("Showing lines 20–21")).toBeVisible();
    const body = document.querySelector<HTMLElement>(".pwa-tool-reader-scroll")!;
    expect(body.textContent).not.toContain("offset:");
    expect(body.textContent).toContain("3 more lines in file");
    await screen.getByRole("button", { name: "Copy content", exact: true }).click();
    expect(copied).toHaveBeenLastCalledWith("alpha\nbeta");
    expect(body.querySelector(".pwa-tool-reader-command")).toBeNull();
  } finally { copied.mockRestore(); await screen.unmount(); }
});

test("Read preserves a selected empty last line and copies its original newline", async () => {
  const current: ToolValue = { ...base, args: { path: "a.ts", offset: 1, limit: 2 }, result: [{ type: "text", text: "alpha\n\n\n[2 more lines in file. Use offset=3 to continue.]" }] };
  const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByText("Showing lines 1–2")).toBeVisible();
    const rows = document.querySelectorAll(".pwa-reader-source-row");
    expect(rows).toHaveLength(2);
    expect(rows[1].querySelector(".pwa-reader-line-number")?.textContent).toBe("2");
    expect(rows[1].querySelector(".pwa-reader-source-text")?.textContent).toBe("");
    await screen.getByRole("button", { name: "Copy content", exact: true }).click();
    expect(copied).toHaveBeenLastCalledWith("alpha\n");
  } finally { copied.mockRestore(); await screen.unmount(); }
});

test.each([390, 320])("full paths wrap without a toggle or body overflow at %s", async width => {
  await page.viewport(width, 844);
  const path = `docs/${"very-long-directory/".repeat(8)}20260824-pwa-hardening.md`;
  const current: ToolValue = { ...base, args: { path, offset: 53, limit: 60 }, result: [{ type: "text", text: "body" }] };
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByText("Showing lines 53–53")).toBeVisible();
    const body = document.querySelector<HTMLElement>(".pwa-tool-reader-scroll")!;
    const pathNode = body.querySelector<HTMLElement>(".pwa-reader-file-path")!;
    expect(pathNode.textContent).toBe(path);
    expect(pathNode.clientHeight).toBeGreaterThan(parseFloat(getComputedStyle(pathNode).lineHeight));
    expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth);
    expect(body.querySelector("details, [aria-expanded]")).toBeNull();
    const status = document.querySelector(".pwa-tool-reader-status")!.getBoundingClientRect();
    const back = document.querySelector(".pwa-topbar-back")!.getBoundingClientRect();
    expect(Math.round(status.left)).toBeGreaterThanOrEqual(Math.round(back.right));
  } finally { await screen.unmount(); }
});

test("Write presents submitted content once, hides the receipt and keeps real failure reasons", async () => {
  const current = { ...base, tool: "write", args: { path: "a.ts", content: "const FILE_BODY = 1;" }, result: [{ type: "text", text: "Successfully wrote to a.ts" }] } satisfies ToolValue;
  let fail!: () => void;
  function Harness() {
    const [value, setValue] = useState<ToolValue>(current);
    fail = () => setValue({ ...current, status: "error", error: "Disk is full", result: [{ type: "text", text: "Disk is full" }] });
    return <ToolReader value={value} opened onClose={() => {}} />;
  }
  const screen = await renderPwa(<Harness />);
  try {
    await expect.element(screen.getByText("Written content")).toBeVisible();
    const body = document.querySelector(".pwa-tool-reader-scroll")!;
    expect(body.textContent?.split("FILE_BODY")).toHaveLength(2);
    expect(body.textContent).not.toContain("Successfully wrote");
    expect(body.textContent).not.toContain("content:");
    flushSync(fail);
    await expect.element(screen.getByText("Attempted write content")).toBeVisible();
    expect(body.textContent).toContain("Disk is full");
  } finally { await screen.unmount(); }
});

test("Edit hides hunk headers visually, preserves gaps and copies the full returned patch", async () => {
  const patch = "--- a/a.ts\n+++ b/a.ts\n@@ -18,2 +18,2 @@\n-old\n+new\n context\n@@ -90 +90 @@\n-last\n+end\n";
  const current: ToolValue = { ...base, tool: "edit", args: { path: "src/a.ts", oldText: "PRIVATE_OLD", newText: "PRIVATE_NEW" }, result: { content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/a.ts." }], details: { patch } } };
  const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByRole("region", { name: "Unified diff: old and new line numbers" })).toBeVisible();
    const body = document.querySelector(".pwa-tool-reader-scroll")!;
    expect(body.textContent).not.toMatch(/@@|PRIVATE_|Successfully replaced/);
    expect(body.querySelector(".pwa-reader-diff-omission")?.getAttribute("aria-label")).toBe("Content in between is omitted");
    await screen.getByRole("button", { name: "Copy diff", exact: true }).click();
    expect(copied).toHaveBeenLastCalledWith(patch);
  } finally { copied.mockRestore(); await screen.unmount(); }
});

test.each(["patch", "native"] as const)("Edit keeps its content columns aligned across line-number widths in %s differences", async format => {
  await page.viewport(320, 740);
  const source = format === "patch" ? "--- a/a.ts\n+++ b/a.ts\n@@ -999,2 +1000,2 @@\n-before\n+after\n same" : "-999 before\n+1000 after\n 1000 same";
  const current: ToolValue = { ...base, tool: "edit", args: { path: "a.ts" }, result: { content: [], details: { [format === "patch" ? "patch" : "diff"]: source } } };
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByRole("region", { name: "Unified diff: old and new line numbers" })).toBeVisible();
    const rows = [...document.querySelectorAll<HTMLElement>(".pwa-reader-diff-row")];
    expect(rows).toHaveLength(3);
    for (const selector of [".pwa-reader-diff-text", ".pwa-reader-diff-sign"]) {
      expect(new Set(rows.map(row => Math.round(row.querySelector(selector)!.getBoundingClientRect().left))).size).toBe(1);
    }
    const scroll = document.querySelector<HTMLElement>(".pwa-tool-reader-scroll")!;
    expect(scroll.scrollWidth).toBe(scroll.clientWidth);
  } finally { await screen.unmount(); }
});

test("unknown tools keep real results without exposing their arguments", async () => {
  const current: ToolValue = { ...base, tool: "deploy", args: { target: "PRIVATE_ARG" }, result: [{ type: "text", text: "Published: https://example.test/preview" }] };
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByRole("dialog", { name: "deploy", exact: true })).toBeVisible();
    await expect.element(screen.getByText("Published: https://example.test/preview")).toBeVisible();
    expect(document.querySelector(".pwa-tool-reader-scroll")!.textContent).not.toContain("PRIVATE_ARG");
    expect(document.querySelector(".pwa-reader-block .pwa-reader-toolbar span")?.textContent).toBe("Result");
  } finally { await screen.unmount(); }
});

test("the desktop header identifies the action with readable status and keeps close available", async () => {
  const current: ToolValue = { ...base, tool: "bash", args: { command: "pnpm test" }, result: [{ type: "text", text: "3 passed" }] };
  const screen = await renderPwa(<ToolReader value={current} opened onClose={() => {}} />);
  try {
    await expect.element(screen.getByRole("dialog", { name: "Run pnpm test", exact: true })).toBeVisible();
    const title = document.querySelector<HTMLElement>(".pwa-tool-reader-title")!;
    const status = document.querySelector<HTMLElement>(".pwa-tool-reader-status")!;
    expect(title.textContent).toBe("Runpnpm test");
    expect(getComputedStyle(title).fontSize).toBe("18px");
    expect(status.textContent).toBe("Complete");
    expect(status.querySelector(".pwa-sr-only")).toBeNull();
    expect(getComputedStyle(status).fontWeight).toBe("400");
    expect(Math.round(status.getBoundingClientRect().left)).toBeGreaterThanOrEqual(Math.round(title.getBoundingClientRect().right));
    expect(document.querySelector(".pwa-tool-reader-actions .pwa-tool-reader-close")).not.toBeNull();
  } finally { await screen.unmount(); }
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
