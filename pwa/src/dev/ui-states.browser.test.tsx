import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { UiStateGalleryPage } from "./ui-states";
import { GALLERY_CODE, type GalleryState } from "./ui-state-fixtures";

const input = () => document.querySelector<HTMLTextAreaElement>(".pwa-composer textarea")!;
const split = () => document.querySelector(".pwa-work-panel-layout")?.hasAttribute("data-split");
const file = (id: string) => document.querySelector<HTMLElement>(`[data-publication-id="${id}"]`)!;
async function settle() {
  await Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
async function choose(state: GalleryState) {
  await page.getByLabelText("演示状态", { exact: true }).selectOptions(state);
  await expect.poll(() => document.querySelector(".pwa-ui-states")?.getAttribute("data-state")).toBe(state);
}
async function openTool() {
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-tool-group > .pwa-tool-head > button")!);
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")!);
  await expect.poll(() => document.querySelector(".pwa-tool-reader-scroll")).not.toBeNull();
}
async function viewFile(id: string) {
  await userEvent.click(file(id).querySelector<HTMLButtonElement>(".pwa-published-actions button")!);
  await expect.poll(() => document.querySelector(".pwa-file-reader-scroll")).not.toBeNull();
}
async function closeReader() {
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => Boolean(history.state?.piReachFileReader || history.state?.piReachToolReader)).toBe(false);
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  await expect.poll(split).toBe(false);
}
beforeEach(async () => { await page.viewport(1440, 1000); });
afterEach(async () => {
  vi.restoreAllMocks();
  await expect.poll(() => Boolean(history.state?.piReachFileReader || history.state?.piReachToolReader)).toBe(false);
});

test("real state fixtures expose thinking, running tools, failures and explicit tool/attachment retries", async () => {
  await render(<UiStateGalleryPage />);
  await expect.element(page.getByText("检查阅读与输入的关系", { exact: true })).toBeVisible();
  await expect.poll(() => document.querySelector(".pwa-thinking-live .pwa-spin")).not.toBeNull();
  await choose("tools");
  await openTool();
  expect(document.querySelector(".pwa-tool-reader-scroll")?.textContent).toContain("此命令没有实际执行");
  expect(split()).toBe(true);
  await closeReader();
  await choose("failure");
  expect(document.querySelector('.pwa-attachment-card[data-status="failed"]')).not.toBeNull();
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-attachment-actions button")!);
  await expect.poll(() => document.querySelector('.pwa-attachment-card[data-status="complete"]')).not.toBeNull();
  await page.getByRole("button", { name: "演示工具重试", exact: true }).click();
  await expect.element(page.getByText("演示工具重试已完成。", { exact: true })).toBeVisible();
  await openTool();
  expect(document.querySelector(".pwa-tool-reader-scroll")?.textContent).toContain("重试完成");
  await closeReader();
});

test("one real Composer retains its draft through theme, speed, width and fixture changes, and menus execute locally", async () => {
  await render(<UiStateGalleryPage />);
  const composer = input();
  await userEvent.fill(composer, "保留这个草稿");
  await page.getByLabelText("外观 · 仅本页", { exact: true }).selectOptions("dark");
  await page.getByRole("button", { name: "动画速度 · 1×", exact: true }).click();
  await page.getByRole("button", { name: "窄主区 · 760px", exact: true }).click();
  await choose("long");
  expect(input()).toBe(composer);
  expect(composer.value).toBe("保留这个草稿");
  expect(document.documentElement.getAttribute("data-mantine-color-scheme")).toBe("dark");
  expect(Math.round(document.querySelector(".pwa-ui-states-workspace")!.getBoundingClientRect().width)).toBe(760);
  const command = document.querySelector<HTMLButtonElement>(".pwa-composer-command button")!;
  command.focus();
  await userEvent.click(command);
  await expect.poll(() => document.querySelector('[role="menu"]')).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector('[role="menu"]')).toBeNull();
  await expect.poll(() => document.activeElement).toBe(command);
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-composer-send")!);
  await expect.element(page.getByText("已演示发送，草稿保留；未发送到 Pi。", { exact: true })).toBeVisible();
  const notice = document.querySelector(".pwa-composer-hint")!;
  expect(notice.compareDocumentPosition(document.querySelector(".pwa-composer-card")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(composer.value).toBe("保留这个草稿");
});

test("tool and text share one panel, then the same reader migrates to a narrow Drawer and returns focus", async () => {
  await render(<UiStateGalleryPage />);
  await choose("files");
  await openTool();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
  await viewFile("notes");
  await expect.poll(split).toBe(true);
  expect(document.querySelectorAll(".pwa-work-panel-host .pwa-reader-portal")).toHaveLength(1);
  await expect.poll(() => document.querySelector(".pwa-file-reader-scroll h1")?.textContent).toBe("阅读与对话并排");
  await settle();
  const reader = document.querySelector<HTMLElement>(".pwa-file-reader-scroll")!;
  const heading = reader.querySelectorAll("h2")[2]!;
  reader.scrollTop += heading.getBoundingClientRect().top - reader.getBoundingClientRect().top;
  expect(reader.scrollTop).toBeGreaterThan(0);
  await page.getByRole("button", { name: "窄主区 · 760px", exact: true }).click();
  await expect.element(page.getByRole("dialog", { name: "界面演示.md", exact: true })).toBeVisible();
  await settle();
  expect(document.querySelector(".pwa-file-reader-scroll")).toBe(reader);
  expect(reader.scrollTop).toBeGreaterThan(0);
  await expect.poll(() => history.state?.piReachFileReader).toBeTruthy();
  await closeReader();
  expect(document.activeElement).not.toBe(document.body);
  expect(file("notes").contains(document.activeElement)).toBe(true);
});

test("real phone viewport opens full-screen text and image readers and Back clears reader history", async () => {
  await page.viewport(390, 844);
  await render(<UiStateGalleryPage />);
  await choose("files");
  await viewFile("notes");
  const dialog = page.getByRole("dialog", { name: "界面演示.md", exact: true });
  await expect.element(dialog).toBeVisible();
  expect(Math.round(dialog.element().getBoundingClientRect().width)).toBe(390);
  await expect.poll(() => history.state?.piReachFileReader).toBeTruthy();
  history.back();
  await expect.poll(() => history.state?.piReachFileReader).toBeUndefined();
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  await expect.poll(() => file("picture").querySelector<HTMLImageElement>("img")?.naturalWidth).toBe(640);
  await userEvent.click(file("picture").querySelector<HTMLButtonElement>(".pwa-published-image")!);
  await expect.element(page.getByRole("dialog", { name: "内存布局.png", exact: true })).toBeVisible();
  await expect.poll(() => document.querySelector<HTMLImageElement>('[role="dialog"] img')?.naturalWidth).toBe(640);
  expect(split()).toBe(false);
  await closeReader();
});

test.each([[390, 844], [320, 740], [844, 390]])("gallery scrolling keeps the Composer reachable at %ipx × %ipx", async (width, height) => {
  await page.viewport(width, height);
  await render(<UiStateGalleryPage />);
  await choose("failure");
  const root = document.querySelector<HTMLElement>(".pwa-ui-states")!;
  root.scrollTop = root.scrollHeight;
  await expect.poll(() => Math.round(input().getBoundingClientRect().bottom)).toBeLessThanOrEqual(height);
  await expect.poll(() => Math.round(input().getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
  for (const control of root.querySelectorAll("select")) {
    expect(Math.round(control.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
  await userEvent.fill(input(), "短窗口仍可编辑");
  expect(input().value).toBe("短窗口仍可编辑");
});

test("file progress stays controlled, cancellation and explicit completion change real cards, error retry opens text", async () => {
  await render(<UiStateGalleryPage />);
  await choose("files");
  expect(file("reading").textContent).toContain("50%");
  expect(file("error").querySelector('[role="alert"]')).not.toBeNull();
  await userEvent.click(file("reading").querySelector<HTMLButtonElement>("button")!);
  await expect.poll(() => file("reading").querySelector('[role="status"]')).toBeNull();
  await page.getByRole("button", { name: "演示获取完成", exact: true }).click();
  await expect.poll(() => file("reading").querySelector("a[download]")).not.toBeNull();
  await viewFile("error");
  await expect.poll(() => document.querySelector(".pwa-file-reader-scroll")?.textContent).toContain("阅读与对话并排");
  expect(file("error").querySelector('[role="alert"]')).toBeNull();
  await closeReader();
});

test("the real code CopyButton waits for clipboard resolution, copies exact content, and shows a rejected write as failure", async () => {
  await render(<UiStateGalleryPage />);
  await choose("long");
  let finish!: () => void;
  const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const copy = document.querySelector<HTMLButtonElement>(".pwa-code-block button, .pwa-code button, pre button") ?? document.querySelector<HTMLButtonElement>(".pwa-message .pwa-copy-icons")!.closest("button")!;
  await userEvent.click(copy);
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(GALLERY_CODE);
  expect(copy.querySelector("[data-copied]")).toBeNull();
  finish();
  await expect.poll(() => copy.querySelector("[data-copied]")).not.toBeNull();
  clipboard.mockRejectedValueOnce(new Error("Denied"));
  await userEvent.click(copy);
  await expect.poll(() => copy.querySelector("[data-copied]")).toBeNull();
  await expect.poll(() => document.querySelector(".pwa-copy-error")).not.toBeNull();
});

test("native clipboard outcome drives production feedback without claiming an unconfirmed write", async () => {
  await render(<UiStateGalleryPage />);
  await choose("long");
  const clipboard = vi.spyOn(navigator.clipboard, "writeText");
  const icon = document.querySelector<HTMLElement>(".pwa-message .pwa-copy-icons")!;
  await userEvent.click(icon.closest("button")!);
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(GALLERY_CODE);
  const succeeded = await clipboard.mock.results[0].value.then(() => true, () => false);
  await expect.poll(() => icon.hasAttribute("data-copied")).toBe(succeeded);
  if (!succeeded) await expect.poll(() => document.querySelector(".pwa-copy-error")).not.toBeNull();
});

test("live reduced-motion preference pauses actual running icons and takes precedence over slow motion, with cleanup", async () => {
  const nativeMatchMedia = window.matchMedia.bind(window);
  const media = new EventTarget();
  let reduced = false;
  const query = Object.assign(media, { media: "(prefers-reduced-motion: reduce)", get matches() { return reduced; }, onchange: null, addListener() {}, removeListener() {} });
  Object.defineProperty(query, "matches", { get: () => reduced });
  vi.spyOn(window, "matchMedia").mockImplementation(value => value === query.media ? query as MediaQueryList : nativeMatchMedia(value));
  const screen = await render(<UiStateGalleryPage />);
  await page.getByRole("button", { name: "动画速度 · 1×", exact: true }).click();
  await expect.poll(() => document.documentElement.style.getPropertyValue("--pwa-duration-drawer")).not.toBe("");
  expect(document.documentElement.style.getPropertyValue("--pwa-duration-collapse-in")).toBe("720ms");
  expect(document.documentElement.style.getPropertyValue("--pwa-duration-image-in")).toBe("1040ms");
  expect(document.documentElement.style.getPropertyValue("--pwa-duration-fetch-settle")).toBe("");
  reduced = true;
  media.dispatchEvent(new MediaQueryListEvent("change", { matches: true, media: query.media }));
  await expect.poll(() => document.documentElement.style.getPropertyValue("--pwa-duration-drawer")).toBe("");
  await expect.poll(() => document.querySelector(".pwa-spin")?.getAttribute("data-pwa-animation")).toBe("paused");
  expect(document.querySelector(".pwa-ui-states-motion")?.textContent).toContain("已开启");
  reduced = false;
  media.dispatchEvent(new MediaQueryListEvent("change", { matches: false, media: query.media }));
  await expect.poll(() => document.documentElement.style.getPropertyValue("--pwa-duration-drawer")).not.toBe("");
  await screen.unmount();
  expect(document.documentElement.style.getPropertyValue("--pwa-duration-drawer")).toBe("");
});

test("theme, menus and fixtures leave browser storage/network untouched and release every Blob URL on unmount", async () => {
  const snapshot = () => [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
  const before = snapshot();
  const write = vi.spyOn(Storage.prototype, "setItem");
  const remove = vi.spyOn(Storage.prototype, "removeItem");
  const database = vi.spyOn(indexedDB, "open");
  const network = vi.spyOn(window, "fetch");
  const create = vi.spyOn(URL, "createObjectURL");
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const screen = await render(<UiStateGalleryPage />);
  await userEvent.fill(input(), "不写存储");
  await page.getByLabelText("外观 · 仅本页", { exact: true }).selectOptions("dark");
  await choose("files");
  await viewFile("notes");
  await closeReader();
  await choose("long");
  await screen.unmount();
  expect(snapshot()).toEqual(before);
  expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  expect(database).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(2);
  expect(revoke.mock.calls.map(call => call[0]).sort()).toEqual(create.mock.results.map(result => result.value).sort());
});
