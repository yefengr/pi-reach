import { expect, type Page } from "playwright/test";

/**
 * 当前活动会话就绪：主区声明 online，且实时 Composer 的 Pi commands 可用。
 * 成功连接不再显示标题区状态标签（ADR-20261105）；只读输入会让该按钮禁用，因此不能只凭
 * textarea 可编辑、Relay 在线或某个元素消失来判定当前会话已连接。
 */
export async function expectLiveSessionConnected(page: Page, timeout?: number): Promise<void> {
  const options = timeout === undefined ? undefined : { timeout };
  const main = page.locator("main.pwa-main[data-connection]");
  await expect(main).toBeVisible(options);
  await expect(main).toHaveAttribute("data-connection", "online", options);
  const composer = main.locator("form.pwa-composer");
  await expect(composer).toBeVisible(options);
  const commands = composer.getByRole("button", { name: "Pi commands", exact: true });
  await expect(commands).toBeVisible(options);
  await expect(commands).toBeEnabled(options);
}

/**
 * 断连：主区确实带有连接状态且不再是 online，等待真实状态转换。
 * 不要求 Composer 卸载、工具停止或草稿清空，也不依赖已移除的状态标签 detached。
 */
export async function expectLiveSessionDisconnected(page: Page, timeout?: number): Promise<void> {
  const options = timeout === undefined ? undefined : { timeout };
  const main = page.locator("main.pwa-main[data-connection]");
  await expect(main).toBeVisible(options);
  await expect(main).not.toHaveAttribute("data-connection", "online", options);
}
