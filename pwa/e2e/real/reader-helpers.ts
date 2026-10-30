import { expect, type ElementHandle, type Locator, type Page } from "playwright/test";

const STREAM_TRIGGER = "E2E stream tool fixture";
const FILE_NAME = "report-中文.md";
const WIDE = { width: 1600, height: 900 };
const PHONE = { width: 390, height: 844 };

export async function waitForReaderHistoryClear(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => Boolean(history.state?.piReachFileReader || history.state?.piReachToolReader))).toBe(false);
}

/** 工具与文本共用一个右侧 Drawer：桌面 720px、移动全屏，均有遮罩与 history。 */
export async function expectTextReader(page: Page): Promise<Locator> {
  const reader = page.getByRole("dialog", { name: FILE_NAME, exact: true });
  await expect(reader).toBeVisible();
  await expect(reader.getByRole("link", { name: "Save file", exact: true })).toBeVisible();
  await expect(page.locator(".pwa-work-panel, .pwa-work-panel-layout")).toHaveCount(0);
  return reader;
}

function fileCard(page: Page): Locator {
  return page.locator(".pwa-published-file").filter({ has: page.locator(".pwa-published-name", { hasText: FILE_NAME }) });
}

function streamGroup(page: Page, saved = false): Locator {
  const groups = page.locator(".pwa-process-group");
  // 新打开的只读历史默认折叠，先用可见摘要定位，再由调用方展开并验证真实输出。
  return saved
    ? groups.filter({ has: page.locator(".pwa-process-summary", { hasText: /^Ran 1 command$/ }) })
    : groups.filter({ hasText: "E2E stream start" });
}

async function openStreamTool(page: Page, saved = false): Promise<Locator> {
  const group = streamGroup(page, saved);
  await expect(group).toHaveCount(1);
  const toggle = group.locator(":scope > button.pwa-process-head");
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  const tool = group.getByRole("button", { name: "View bash tool details", exact: true });
  await expect(tool).toBeVisible();
  await tool.focus();
  await tool.click();
  const panel = page.getByRole("dialog", { name: "bash", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.locator(".pwa-tool-reader-scroll")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Close tool details", exact: true })).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-scroll-locked");
  return panel;
}

async function expectSameBody(body: ElementHandle<HTMLElement | SVGElement>): Promise<void> {
  expect(await body.evaluate(node => node.isConnected && document.querySelector(".pwa-tool-reader-scroll, .pwa-file-reader-scroll") === node)).toBe(true);
}

async function verifyPhoneBack(page: Page): Promise<void> {
  const url = page.url();
  await page.setViewportSize(PHONE);
  const dialog = page.getByRole("dialog", { name: "bash", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".pwa-reader-text")).toContainText("E2E stream complete");
  await expect.poll(() => dialog.evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(PHONE.width);
  await expect.poll(() => page.evaluate(() => Boolean(history.state?.piReachToolReader))).toBe(true);
  await page.evaluate(() => history.back());
  await waitForReaderHistoryClear(page);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".pwa-tool-reader-scroll")).toHaveCount(0);
  expect(page.url()).toBe(url);
  await expect(page.locator(".pwa-composer textarea")).toBeEditable();
  await page.setViewportSize(WIDE);
}

async function expectDurableMessage(owners: readonly [Page, Page], text: string): Promise<void> {
  for (const owner of owners) {
    await expect(owner.locator(".pwa-message.user:not(.pending) .pwa-user-blocks > p").filter({ hasText: new RegExp(`^${text}$`) })).toHaveCount(1, { timeout: 60_000 });
  }
}

async function verifySavedHistory(page: Page, newDraft: string): Promise<void> {
  // 历史按 updatedAt 倒序；刚切出的验收会话应是首项，并用真实内容复核归属。
  const history = page.locator("#pwa-desktop-navigation .pwa-history-row").first();
  await expect(history).toBeVisible();
  await history.click();
  await expect(history).toHaveAttribute("aria-current", "true");
  const composer = page.locator(".pwa-composer textarea");
  await expect(composer).toBeDisabled();
  await expect(page.getByText("This is a session saved in this browser. It's read-only.", { exact: true })).toBeVisible();
  await expect(page.locator(".pwa-message.user:not(.pending)").filter({ hasText: STREAM_TRIGGER })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Pi commands", exact: true })).toBeDisabled();
  for (const name of [FILE_NAME, "image.png", "data.bin"]) {
    const file = page.locator(".pwa-published-file").filter({ has: page.locator(".pwa-published-name", { hasText: name }) });
    await expect(file.locator(".pwa-published-name")).toHaveText(name);
    await expect(file.locator(".pwa-published-meta").first()).toHaveText(/^\d+(?:[,.]\d+)? (?:B|KiB)$/);
    await expect(file.locator("button, a, img")).toHaveCount(0);
    await expect(file.getByText("Connect and open the original session to fetch", { exact: true })).toBeVisible();
  }
  const panel = await openStreamTool(page, true);
  await expect(panel.locator(".pwa-reader-text")).toContainText("E2E stream complete");
  await expect(panel.locator(".pwa-tool-reader-status")).toHaveClass(/pwa-tool-status-complete/);
  await panel.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect(page.locator(".pwa-tool-reader-scroll")).toHaveCount(0);
  const online = page.locator("#pwa-desktop-navigation .pwa-nav-session");
  await expect(online).toHaveCount(1);
  await online.click();
  await expect(online).toHaveAttribute("aria-current", "true");
  await expect(page.getByLabel("Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(composer).toBeEditable();
  await expect(composer).toHaveValue(newDraft);
}

export async function verifyReaderDrawerLive(
  owners: readonly [Page, Page], sessionId: string,
  startFreshSession: (previousSessionId: string) => Promise<{ sessionId?: string | null }>,
): Promise<string> {
  const [page, otherOwner] = owners;
  await page.setViewportSize(WIDE);
  const composer = page.locator(".pwa-composer textarea");
  const originalComposer = await composer.elementHandle();
  if (!originalComposer) throw new Error("Live Composer is unavailable.");
  const completions = await page.locator(".pwa-turn-meta").count();
  await expect(page.getByRole("button", { name: "Stop current task", exact: true })).toHaveCount(0);
  await composer.fill(STREAM_TRIGGER);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop current task", exact: true })).toBeVisible();
  await expect(streamGroup(page)).toHaveCount(1);
  const panel = await openStreamTool(page);
  const output = panel.locator(".pwa-reader-text");
  await expect(output).toContainText("E2E stream start");
  await expect(panel.locator(".pwa-tool-reader-status")).toHaveClass(/pwa-tool-status-running/);
  await expect(page.getByRole("button", { name: "Stop current task", exact: true })).toBeVisible();
  // 抽屉为模态覆盖：对话被遮罩隔开，不能边读边输入。
  await expect(page.locator("body")).toHaveAttribute("data-scroll-locked");
  await expect(composer).not.toBeFocused();
  const body = await panel.locator(".pwa-tool-reader-scroll").elementHandle();
  if (!body) throw new Error("Streaming tool body is unavailable.");
  const ticks = (text: string) => Array.from(text.matchAll(/E2E stream tick (\d+)/g), match => Number(match[1]));
  const firstTick = Math.max(0, ...ticks(await output.innerText()));
  await expect.poll(async () => Math.max(0, ...ticks(await output.innerText()))).toBeGreaterThan(firstTick);
  await expectSameBody(body);
  await expect(output).toContainText("E2E stream complete", { timeout: 60_000 });
  // stdout 的完成 marker 不能替代真实工具状态和正式 run_end。
  await expect(panel.locator(".pwa-tool-reader-status")).toHaveClass(/pwa-tool-status-complete/);
  await expect(page.locator(".pwa-turn-meta")).toHaveCount(completions + 1, { timeout: 60_000 });
  for (const owner of owners) await expect(owner.getByRole("button", { name: "Stop current task", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect(page.locator(".pwa-tool-reader-scroll")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked");
  const draft = "E2E draft kept after reading the stream";
  await composer.fill(draft);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expectDurableMessage(owners, draft);
  await expect(composer).toHaveValue("");
  const nextDraft = "E2E draft survives other Owner leaf";
  await composer.fill(nextDraft);
  await expect(otherOwner.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await expect(otherOwner.getByRole("button", { name: "Stop current task", exact: true })).toHaveCount(0);
  const reopened = await openStreamTool(page);
  const reopenedBody = await reopened.locator(".pwa-tool-reader-scroll").elementHandle();
  if (!reopenedBody) throw new Error("Reopened tool body is unavailable.");
  await otherOwner.locator(".pwa-composer textarea").fill("E2E second Owner advances leaf");
  await expect(otherOwner.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await otherOwner.getByRole("button", { name: "Send message", exact: true }).click();
  await expectDurableMessage(owners, "E2E second Owner advances leaf");
  // leaf 推进只更新正文，不重建抽屉或阅读内容。
  await expectSameBody(reopenedBody);
  await expect(reopened.locator(".pwa-reader-text")).toContainText("E2E stream complete");
  await reopened.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect(page.locator(".pwa-tool-reader-scroll")).toHaveCount(0);
  await expect(composer).toHaveValue(nextDraft);
  await fileCard(page).getByRole("button", { name: "View", exact: true }).click();
  const textReader = await expectTextReader(page);
  await expect(textReader.getByRole("heading", { name: "Published fixture report", exact: true })).toBeVisible();
  await expect(page.locator(".pwa-tool-reader-scroll")).toHaveCount(0);
  await textReader.getByRole("button", { name: "Close file reader", exact: true }).click();
  await waitForReaderHistoryClear(page);
  await expect(page.locator(".pwa-file-reader-scroll")).toHaveCount(0);
  await expect(composer).toHaveValue(nextDraft);
  await openStreamTool(page);
  await verifyPhoneBack(page);
  await expect(composer).toHaveValue(nextDraft);
  await openStreamTool(page);
  await expect(page.getByRole("button", { name: "Stop current task", exact: true })).toHaveCount(0);
  // 抽屉为模态，切换到新会话前先结束阅读；切换后不应残留任何阅读器。
  await page.getByRole("button", { name: "Close tool details", exact: true }).click();
  await expect(page.locator(".pwa-tool-reader-scroll")).toHaveCount(0);
  await waitForReaderHistoryClear(page);
  const fresh = await startFreshSession(sessionId);
  expect(fresh.sessionId).toBeTruthy();
  expect(fresh.sessionId).not.toBe(sessionId);
  await expect(page.locator(".pwa-tool-reader-scroll, .pwa-file-reader-scroll")).toHaveCount(0);
  await expect(page.locator(".pwa-work-panel, .pwa-work-panel-layout")).toHaveCount(0);
  await waitForReaderHistoryClear(page);
  await expect(composer).toHaveValue("");
  await expect(page.locator(".pwa-message.user")).toHaveCount(0);
  const newDraft = "E2E new session draft survives history";
  await composer.fill(newDraft);
  await verifySavedHistory(page, newDraft);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expectDurableMessage(owners, newDraft);
  await expect(page.getByRole("button", { name: "Stop current task", exact: true })).toHaveCount(0);
  await body.dispose();
  await reopenedBody.dispose();
  await originalComposer.dispose();
  return fresh.sessionId!;
}
