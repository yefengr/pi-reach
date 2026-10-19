import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { UiStateGalleryPage } from "./ui-states";
import type { GalleryState } from "./ui-state-fixtures";

const input = () => document.querySelector<HTMLTextAreaElement>(".pwa-composer textarea")!;
const send = () => document.querySelector<HTMLButtonElement>(".pwa-composer-send")!;
const reader = () => document.querySelector<HTMLElement>(".pwa-tool-reader-scroll");
const group = () => document.querySelector<HTMLButtonElement>(".pwa-tool-group > .pwa-tool-head > button")!;
const historyOpen = () => Boolean(history.state?.piReachFileReader || history.state?.piReachToolReader || history.state?.piReachSummaryReader);
async function choose(state: GalleryState) {
  await page.getByLabelText("演示状态", { exact: true }).selectOptions(state);
  await expect.poll(() => document.querySelector(".pwa-ui-states")?.getAttribute("data-state")).toBe(state);
}
async function openModels() {
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-composer-model")!);
  await expect.poll(() => document.querySelector('[data-command-view="models"]')).not.toBeNull();
  await userEvent.click(document.querySelector<HTMLButtonElement>('[data-command-view="models"]')!);
}
async function closeOverlay() {
  await userEvent.keyboard("{Escape}");
  await expect.poll(historyOpen).toBe(false);
  await expect.poll(() => document.querySelector('[role="dialog"], [role="menu"]')).toBeNull();
}
async function next(step: number) {
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect.poll(() => document.querySelector("[data-flow-step]")?.getAttribute("data-flow-step")).toBe(String(step));
}
beforeEach(async () => { await page.viewport(1440, 1000); });
afterEach(async () => {
  vi.restoreAllMocks();
  await expect.poll(historyOpen).toBe(false);
});

test("empty and delayed loading use the production list and retain the same draft", async () => {
  await render(<UiStateGalleryPage />);
  const composer = input();
  await userEvent.fill(composer, "加载前的草稿");
  await choose("empty");
  expect(document.querySelector(".pwa-chat-empty-context")?.textContent).toContain("pi-reach");
  expect(input()).toBe(composer);
  await choose("loading");
  expect(document.querySelector(".pwa-chat-empty")).toBeNull();
  await expect.poll(() => document.querySelectorAll(".pwa-skeleton-rows .pwa-skeleton").length).toBe(3);
  await page.getByRole("button", { name: "演示加载完成", exact: true }).click();
  await expect.poll(() => document.querySelector(".pwa-skeleton-rows")).toBeNull();
  expect(input()).toBe(composer);
  expect(composer.value).toBe("加载前的草稿");
});

test.each(["offline", "reconnecting"] as const)("%s prevents send and explicitly recovers in memory", async state => {
  await render(<UiStateGalleryPage />);
  const composer = input();
  await userEvent.fill(composer, "恢复后仍保留");
  await choose(state);
  expect(document.querySelector(".pwa-connection-banner")).not.toBeNull();
  expect(send().disabled).toBe(true);
  expect(document.querySelector(".pwa-composer-stop")).toBeNull();
  composer.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(document.querySelector(".pwa-composer-hint")?.textContent).not.toContain("已演示发送");
  expect(composer.value).toBe("恢复后仍保留");
  await page.getByRole("button", { name: "演示恢复连接", exact: true }).click();
  await expect.poll(() => document.querySelector(".pwa-connection-banner")).toBeNull();
  expect(input()).toBe(composer);
  expect(send().disabled).toBe(false);
  await userEvent.click(send());
  await expect.element(page.getByText("已演示发送，草稿保留；未发送到 Pi。", { exact: true })).toBeVisible();
});

test("model loading uses the real model menu and explicit completion", async () => {
  await render(<UiStateGalleryPage />);
  await choose("models-loading");
  await openModels();
  await expect.poll(() => document.querySelector(".pwa-operation-list-status .pwa-spin")).not.toBeNull();
  expect(getComputedStyle(document.querySelector(".pwa-operation-list-status")!).gap).toBe("6px");
  expect(document.querySelectorAll(".pwa-command-choice")).toHaveLength(0);
  await closeOverlay();
  await page.getByRole("button", { name: "演示模型加载完成", exact: true }).click();
  await openModels();
  await expect.poll(() => document.querySelectorAll(".pwa-command-choice").length).toBeGreaterThan(0);
  await closeOverlay();
});

test("model failure preserves menu context and its real retry switches to successful models", async () => {
  await render(<UiStateGalleryPage />);
  await choose("models-error");
  await openModels();
  const menu = document.querySelector('[role="menu"]')!;
  expect(menu.querySelector('[role="status"]')).not.toBeNull();
  const retry = menu.querySelectorAll<HTMLButtonElement>("[data-menu-item]");
  await userEvent.click(retry[retry.length - 1]);
  await expect.poll(() => document.querySelectorAll(".pwa-command-choice").length).toBeGreaterThan(0);
  expect(document.querySelector('[role="menu"]')).toBe(menu);
  await closeOverlay();
});

test("upload cards expose preparing, 50 percent and paused states with per-item cancellation", async () => {
  await render(<UiStateGalleryPage />);
  await choose("uploading");
  for (const status of ["preparing", "uploading", "paused"]) expect(document.querySelector(`.pwa-attachment-card[data-status="${status}"]`)).not.toBeNull();
  expect(document.querySelector('.pwa-attachment-card[data-status="uploading"]')?.textContent).toContain("50%");
  expect(input().readOnly).toBe(true);
  for (const status of ["preparing", "uploading"]) {
    await userEvent.click(document.querySelector<HTMLButtonElement>(`.pwa-attachment-card[data-status="${status}"] .pwa-attachment-actions button`)!);
    expect(document.querySelector(`.pwa-attachment-card[data-status="${status}"]`)).toBeNull();
  }
  expect(document.querySelector('.pwa-attachment-card[data-status="paused"]')).not.toBeNull();
  await page.getByRole("button", { name: "演示附件完成", exact: true }).click();
  expect(document.querySelectorAll('.pwa-attachment-card[data-status="complete"]')).toHaveLength(1);
  expect(input().readOnly).toBe(false);
});

test.each(["演示命令完成", "取消演示命令"])("pending action is bounded and %s releases the real Composer gate", async action => {
  await render(<UiStateGalleryPage />);
  const composer = input();
  await userEvent.fill(composer, "命令期间保留草稿");
  await choose("pending");
  expect(composer.readOnly).toBe(true);
  expect(document.querySelector<HTMLButtonElement>(".pwa-composer-command button")?.disabled).toBe(true);
  await page.getByRole("button", { name: action, exact: true }).click();
  expect(input()).toBe(composer);
  expect(composer.readOnly).toBe(false);
  expect(composer.value).toBe("命令期间保留草稿");
  expect(document.querySelector<HTMLButtonElement>(".pwa-composer-command button")?.disabled).toBe(false);
});

test("history uses the real readonly workspace without borrowing ready live files or unmounting the draft", async () => {
  await render(<UiStateGalleryPage />);
  const composer = input();
  await userEvent.fill(composer, "历史返回后保留");
  await choose("files");
  expect(document.querySelector('[data-publication-id="notes"] a[download]')).not.toBeNull();
  await choose("history");
  expect(composer.isConnected).toBe(true);
  expect(composer.closest<HTMLElement>(".pwa-chat-footer")?.hidden).toBe(true);
  expect(composer.closest<HTMLElement>("[inert]")).not.toBeNull();
  const historicalFile = document.querySelector('.pwa-message-list [data-publication-id="notes"]')!;
  expect(historicalFile).not.toBeNull();
  expect(historicalFile.querySelector("a[download]")).toBeNull();
  expect([...historicalFile.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
  const readonly = document.querySelector<HTMLTextAreaElement>(".pwa-chat-footer:not([hidden]) textarea")!;
  expect(readonly.disabled || readonly.readOnly).toBe(true);
  expect(readonly).not.toBe(composer);
  await choose("empty");
  expect(input()).toBe(composer);
  expect(composer.value).toBe("历史返回后保留");
});

test("compaction, branch summary and provider error open the real SummaryReader and return focus", async () => {
  await render(<UiStateGalleryPage />);
  await choose("summaries");
  const actions = [...document.querySelectorAll<HTMLButtonElement>(".pwa-summary-action")];
  expect(actions).toHaveLength(3);
  expect(document.querySelectorAll(".pwa-summary-entry.provider_error")).toHaveLength(1);
  for (const action of actions) {
    action.focus();
    await userEvent.click(action);
    await expect.poll(() => document.querySelector(".pwa-summary-reader-scroll")?.textContent?.length ?? 0).toBeGreaterThan(0);
    await expect.poll(() => history.state?.piReachSummaryReader).toBe(true);
    await closeOverlay();
    expect(document.activeElement).toBe(action);
  }
});

test("real pending delivery retry and cancellation update only their messages", async () => {
  await render(<UiStateGalleryPage />);
  await choose("delivery");
  expect(document.querySelectorAll(".pwa-pending")).toHaveLength(3);
  const unknown = [...document.querySelectorAll<HTMLElement>(".pwa-pending")].find(element => element.textContent?.includes("投递状态未知。"))!;
  await userEvent.click(unknown.querySelector<HTMLButtonElement>("button")!);
  expect(unknown.querySelector("button")).toBeNull();
  const queued = [...document.querySelectorAll<HTMLElement>(".pwa-pending")].find(element => element.textContent?.includes("这条排队消息"))!;
  await userEvent.click(queued.querySelector<HTMLButtonElement>("button")!);
  expect(document.querySelectorAll(".pwa-pending")).toHaveLength(2);
  await page.getByRole("button", { name: "演示投递完成", exact: true }).click();
  expect(document.querySelectorAll(".pwa-pending")).toHaveLength(0);
});

test("flow preserves thinking, tool expansion, reader and draft through formal leaf advancement, then invalidates the source", async () => {
  await render(<UiStateGalleryPage />);
  const composer = input();
  await userEvent.fill(composer, "连续推进不丢失");
  await choose("flow");
  const thought = document.querySelector<HTMLButtonElement>(".pwa-thinking-head")!;
  await userEvent.click(thought);
  await next(1);
  expect(document.querySelector(".pwa-thinking-head")).toBe(thought);
  expect(thought.getAttribute("aria-expanded")).toBe("true");
  await next(2);
  expect(document.querySelector(".pwa-thinking-head")).toBe(thought);
  expect(thought.getAttribute("aria-expanded")).toBe("true");
  const toolGroup = group();
  await userEvent.click(toolGroup);
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")!);
  await expect.poll(reader).not.toBeNull();
  // 抽屉为模态：阅读器打开时页面控件在遮罩后不可操作，先关闭再推进。
  expect(document.querySelector(".pwa-scrim")).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.poll(reader).toBeNull();
  await next(3);
  await next(4);
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")!);
  await expect.poll(() => reader()?.textContent).toContain("正式结果：检查完成");
  expect(group()).toBe(toolGroup);
  expect(toolGroup.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector(".pwa-turn-meta")).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.poll(reader).toBeNull();
  await next(5);
  expect(document.querySelector('[data-publication-id="notes"]')).not.toBeNull();
  expect(input()).toBe(composer);
  expect(composer.value).toBe("连续推进不丢失");
  await next(6);
  expect(reader()).toBeNull();
  expect(document.querySelector(".pwa-tool-group")).toBeNull();
  await page.getByRole("button", { name: "重放流程", exact: true }).click();
  expect(document.querySelector("[data-flow-step]")?.getAttribute("data-flow-step")).toBe("0");
  expect(input()).toBe(composer);
  expect(composer.value).toBe("连续推进不丢失");
});

test("flow file selection survives ordinary controls and closes on the explicit source change", async () => {
  const create = vi.spyOn(URL, "createObjectURL");
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const screen = await render(<UiStateGalleryPage />);
  await choose("flow");
  for (let step = 1; step <= 5; step++) await next(step);
  await userEvent.click(document.querySelector<HTMLButtonElement>('[data-publication-id="notes"] .pwa-published-actions button')!);
  await expect.poll(() => document.querySelector(".pwa-file-reader-scroll")).not.toBeNull();
  // 模态抽屉需要先关闭才能推进到下一个步骤；源变化后阅读器不再挂载。
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector(".pwa-file-reader-scroll")).toBeNull();
  await next(6);
  await expect.poll(() => document.querySelector(".pwa-file-reader-scroll")).toBeNull();
  await screen.unmount();
  expect(create).toHaveBeenCalledTimes(2);
  expect(revoke.mock.calls.map(call => call[0]).sort()).toEqual(create.mock.results.map(result => result.value).sort());
});
