import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { getMessages } from "@/lib/i18n";
import { UiStateGalleryPage } from "./ui-states";
import { DETAILS_COMPLETE_MS, type GalleryDetailsReply } from "./ui-state-tool-details";

const reader = () => document.querySelector<HTMLElement>(".pwa-tool-reader-scroll");
const notice = () => reader()?.querySelector(".pwa-tool-notice")?.textContent ?? null;
const output = () => reader()?.querySelector(".pwa-reader-text")?.textContent ?? "";
const historyOpen = () => Boolean(history.state?.piReachToolReader);
const reply = (mode: GalleryDetailsReply) => page.getByLabelText("详情返回方式", { exact: true }).selectOptions(mode);
async function openTool(index: number) {
  for (const head of document.querySelectorAll<HTMLButtonElement>("button.pwa-process-head[aria-expanded='false']")) await userEvent.click(head);
  await userEvent.click(document.querySelectorAll<HTMLButtonElement>(".pwa-tool-card .pwa-tool-action")[index]!);
  await expect.poll(reader).not.toBeNull();
}
async function closeReader() {
  await userEvent.keyboard("{Escape}");
  await expect.poll(historyOpen).toBe(false);
  await expect.poll(reader).toBeNull();
}
beforeEach(async () => { await page.viewport(1440, 1000); });
afterEach(async () => {
  vi.restoreAllMocks();
  await expect.poll(historyOpen).toBe(false);
});

test("summary tool rows load details on demand through the production controller with loading, retry, cache, preview and offline states", async () => {
  const database = vi.spyOn(indexedDB, "open");
  const fetch = vi.spyOn(window, "fetch");
  const socket = vi.spyOn(window, "WebSocket");
  const t = getMessages().tools;
  await render(<UiStateGalleryPage />);
  await page.getByLabelText("演示状态", { exact: true }).selectOptions("tool-details");
  await expect.poll(() => document.querySelectorAll(".pwa-tool-card").length).toBe(3);

  await reply("loading");
  await openTool(0);
  await expect.poll(notice).toBe(t.detailsLoading);
  await closeReader();

  await reply("retry");
  await openTool(0);
  await expect.poll(notice).toBe(t.detailsUnavailable);
  await page.getByRole("button", { name: getMessages().common.retry, exact: true }).click();
  await expect.poll(output).toContain("按需返回的完整读取结果");
  await closeReader();

  // 完整详情已进入本页内存缓存：即使改为始终失败，再次打开也直接显示。
  await reply("error");
  await openTool(0);
  await expect.poll(output).toContain("按需返回的完整读取结果");
  await closeReader();
  await openTool(1);
  await expect.poll(notice).toBe(t.detailsUnavailable);
  await closeReader();

  await reply("details");
  await openTool(2);
  await expect.poll(output).toContain("运行中的输出预览");
  expect(notice()).toBe(t.detailsPreview);
  await closeReader();

  await page.getByRole("button", { name: "演示离线", exact: true }).click();
  await openTool(1);
  await expect.poll(notice).toBe(t.detailsOffline);
  await closeReader();
  expect(database).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(socket).not.toHaveBeenCalled();
});

test("a running tool's preview is replaced in place by its formal result while the reader stays open", async () => {
  const t = getMessages().tools;
  await render(<UiStateGalleryPage />);
  await page.getByLabelText("演示状态", { exact: true }).selectOptions("tool-details");
  await reply("complete");
  await openTool(2);
  await expect.poll(output).toContain("运行中的输出预览");
  expect(notice()).toBe(t.detailsPreview);
  const body = reader();
  await expect.poll(output, { timeout: DETAILS_COMPLETE_MS * 3 }).toContain("正式结果：测试通过");
  expect(reader()).toBe(body);
  expect(notice()).toBeNull();
  // 时间线同一行原位转为完成，本轮不再运行。
  await expect.poll(() => document.querySelectorAll(".pwa-tool-card[data-tool-status='complete']").length).toBe(3);
  await closeReader();
  expect(document.querySelector(".pwa-composer-stop")).toBeNull();
  // 切走再返回即重放：时间线回到运行中，缓存也一并清空，再次打开重新请求详情。
  await page.getByLabelText("演示状态", { exact: true }).selectOptions("tools");
  await page.getByLabelText("演示状态", { exact: true }).selectOptions("tool-details");
  await expect.poll(() => document.querySelectorAll(".pwa-tool-card[data-tool-status='complete']").length).toBe(2);
  await reply("loading");
  await openTool(2);
  await expect.poll(notice).toBe(t.detailsLoading);
  await closeReader();
});
