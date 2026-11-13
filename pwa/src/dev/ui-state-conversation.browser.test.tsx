import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { UiStateGalleryPage } from "./ui-states";
import type { GalleryState } from "./ui-state-fixtures";

const input = () => document.querySelector<HTMLTextAreaElement>(".pwa-composer textarea")!;
const send = () => document.querySelector<HTMLButtonElement>(".pwa-composer-send")!;
const reader = () => document.querySelector<HTMLElement>(".pwa-tool-reader-scroll");
const group = () => document.querySelector<HTMLButtonElement>("button.pwa-process-head")!;
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
  // 连接问题在输入框提示行说明（ADR-20261105）。
  const connectionText = state === "offline" ? "网络不可用" : "无法连接 Relay";
  await expect.poll(() => document.querySelector(".pwa-composer-hint")?.textContent ?? "").toContain(connectionText);
  expect(send().disabled).toBe(true);
  expect(document.querySelector(".pwa-composer-stop")).toBeNull();
  composer.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(document.querySelector(".pwa-composer-hint")?.textContent).not.toContain("已演示发送");
  expect(composer.value).toBe("恢复后仍保留");
  await page.getByRole("button", { name: "演示恢复连接", exact: true }).click();
  await expect.poll(() => document.querySelector(".pwa-composer-hint")?.textContent ?? "").not.toContain(connectionText);
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

test("upload tiles expose preparing, a 50 percent ring and paused states with per-item cancellation", async () => {
  await render(<UiStateGalleryPage />);
  await choose("uploading");
  for (const status of ["preparing", "uploading", "paused"]) expect(document.querySelector(`.pwa-attachment-tile[data-status="${status}"]`)).not.toBeNull();
  expect(document.querySelector('.pwa-attachment-tile[data-status="uploading"] [role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50");
  expect(document.querySelector('.pwa-attachment-tile[data-status="uploading"] .pwa-attachment-tile-percent')?.textContent).toBe("50");
  expect(input().readOnly).toBe(true);
  for (const status of ["preparing", "uploading"]) {
    await userEvent.click(document.querySelector<HTMLButtonElement>(`.pwa-attachment-tile[data-status="${status}"] .pwa-attachment-tile-remove`)!);
    // 移除的方块在原位淡出，离开中的副本不可操作，不再算作附件。
    expect(document.querySelector(`.pwa-attachment-tile[data-status="${status}"]:not([data-presence="leaving"])`)).toBeNull();
  }
  expect(document.querySelector('.pwa-attachment-tile[data-status="paused"]')).not.toBeNull();
  await page.getByRole("button", { name: "演示附件完成", exact: true }).click();
  expect(document.querySelectorAll('.pwa-attachment-tile[data-status="complete"]')).toHaveLength(1);
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

test("real pending delivery check and retry update only their messages", async () => {
  await render(<UiStateGalleryPage />);
  await choose("delivery");
  // 对话区只有发送中、未确认与失败三条；排队消息与正式应用一样在输入框上方的排队抽屉中。
  expect(document.querySelectorAll(".pwa-message-list .pwa-pending")).toHaveLength(3);
  await expect.poll(() => document.querySelectorAll(".pwa-composer .pwa-queued-message").length).toBe(2);
  expect(document.querySelector(".pwa-message-list")?.textContent).not.toContain("这条排队消息");
  const unknown = [...document.querySelectorAll<HTMLElement>(".pwa-pending")].find(element => element.textContent?.includes("Not confirmed"))!;
  await userEvent.click(unknown.querySelector<HTMLButtonElement>("button")!);
  expect(unknown.querySelector("button")).toBeNull();
  const failed = [...document.querySelectorAll<HTMLElement>(".pwa-pending")].find(element => element.textContent?.includes("Not sent; check the connection and retry"))!;
  await userEvent.click(failed.querySelector<HTMLButtonElement>("button")!);
  expect(failed.querySelector("button")).toBeNull();
  const queued = [...document.querySelectorAll<HTMLElement>(".pwa-composer .pwa-queued-message")].find(element => element.textContent?.includes("这条排队消息"))!;
  await userEvent.click(queued.querySelector<HTMLButtonElement>(".pwa-queued-message-cancel")!);
  await expect.poll(() => document.querySelectorAll(".pwa-composer .pwa-queued-message").length).toBe(1);
  await page.getByRole("button", { name: "演示投递完成", exact: true }).click();
  expect(document.querySelectorAll(".pwa-pending")).toHaveLength(0);
});

test("flow preserves thinking, tool expansion, reader and draft through formal leaf advancement, then invalidates the source", async () => {
  await render(<UiStateGalleryPage />);
  const composer = input();
  await userEvent.fill(composer, "连续推进不丢失");
  await choose("flow");
  // 运行中的过程组默认展开；先收起再展开，记录一次手动选择。
  const toolGroup = group();
  expect(toolGroup.getAttribute("aria-expanded")).toBe("true");
  await userEvent.click(toolGroup);
  await userEvent.click(toolGroup);
  expect(toolGroup.getAttribute("aria-expanded")).toBe("true");
  await next(1);
  expect(group()).toBe(toolGroup);
  expect(toolGroup.getAttribute("aria-expanded")).toBe("true");
  // 同轮工具加入同一过程组：组身份与手动展开均保持。
  await next(2);
  expect(group()).toBe(toolGroup);
  expect(toolGroup.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelectorAll(".pwa-process-group")).toHaveLength(1);
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
  expect(document.querySelector(".pwa-process-group")).toBeNull();
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

test("tool-types fixture shows every current tool type icon and the edit diff counts", async () => {
  await render(<UiStateGalleryPage />);
  await choose("tool-types");
  const heads = () => [...document.querySelectorAll<HTMLButtonElement>("button.pwa-process-head")];
  await expect.poll(() => heads().length).toBe(2);
  // 已结束的组首次加载即收起：混合类型的组头为步骤列表图标，只有修改的组头为修改图标。
  expect(heads()[0].querySelector(".pwa-process-status-slot svg")).toHaveClass("lucide-list-tree");
  expect(heads()[1].querySelector(".pwa-process-status-slot svg")).toHaveClass("lucide-file-diff");
  await userEvent.click(heads()[0]);
  const icons = () => [...document.querySelectorAll(".pwa-process-group")][0].querySelectorAll(".pwa-tool-card svg[class*='lucide-']");
  await expect.poll(() => [...icons()].map(icon => [...icon.classList].find(name => name.startsWith("lucide-") && name !== "lucide-icon"))).toEqual(
    expect.arrayContaining(["lucide-eye", "lucide-terminal", "lucide-search", "lucide-file-diff", "lucide-pencil"]));
  expect(document.querySelector(".pwa-tool-diff")?.textContent).toBe("+2−1");
});
