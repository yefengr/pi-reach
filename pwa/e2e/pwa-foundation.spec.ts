import { test, expect } from "./fixtures/pwa";

test.use({ serviceWorkers: "block", contextOptions: { reducedMotion: "reduce" } });

test("production computer Popover stays inside the shared safe area", async ({ page, pwa }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "移动端使用底部 Drawer 而非 Popover");
  // 在 Popover 挂载前模拟安全区；其根节点另行固定锚点，避免侧栏内移掩盖 shift 失效。
  const inset = 76;
  await page.addInitScript((safeLeft) => {
    function setInset() {
      if (!document.documentElement) return false;
      document.documentElement.style.setProperty("--pwa-safe-left", `${safeLeft}px`);
      return true;
    }
    if (!setInset()) {
      const observer = new MutationObserver(() => { if (setInset()) observer.disconnect(); });
      observer.observe(document, { childList: true });
    }
  }, inset);
  await pwa.seedWorkspace();
  const root = page.locator(".pwa-root");
  const trigger = page.getByRole("button", { name: /Choose computer, current E2E Pi/ });
  const panel = page.locator(".pwa-device-popover");
  await expect(trigger).toBeVisible();
  expect(await page.locator("html").evaluate((html) => {
    const style = getComputedStyle(html);
    return ["top", "right", "bottom", "left"].map((edge) => style.getPropertyValue(`--pwa-safe-${edge}`).trim());
  })).toEqual(["0px", "0px", "0px", `${inset}px`]);
  expect(await trigger.evaluate((node) => getComputedStyle(node).minHeight)).toBe("44px");
  await root.evaluate((node) => node.style.setProperty("--pwa-safe-left", "0px"));
  await expect.poll(async () => Math.round((await trigger.boundingBox())!.x)).toBeLessThan(inset);

  await trigger.click();
  await expect(panel).toBeVisible();
  await expect.poll(async () => Math.round((await panel.boundingBox())!.x)).toBe(inset);
  expect(await panel.evaluate((node) => node.closest(".pwa-root") !== null)).toBe(true);
  await panel.getByRole("button", { name: "Pair a computer" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("production mobile top bar reserves the shared safe area", async ({ page, pwa }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "移动会话顶栏使用不同的内边距规则");
  await pwa.open();
  const topBar = page.locator(".pwa-title-bar");
  const inset = 30;
  await page.locator("html").evaluate((node, safeTop) => node.style.setProperty("--pwa-safe-top", `${safeTop}px`), inset);
  await expect(topBar).toHaveCSS("padding-top", `${inset}px`);
  await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("dialog");
  await expect(navigation).toBeVisible();
  await navigation.getByRole("button", { name: "Close navigation" }).click();
  await expect(navigation).toHaveCount(0);
});
