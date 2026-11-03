import type { Page } from "playwright/test";
import { test, expect } from "./fixtures/pwa";

const WIDTH_KEY = "pi-reach-sidebar-width";
const SEED_MARKER = "pi-reach-e2e-sidebar-seeded";
const separator = (page: Page) => page.locator('.pwa-sidebar-resizer[aria-controls="pwa-desktop-navigation"]');

// 原生 pointer capture 在顶层生产页面验证，不依赖 Browser Mode 的缩放 iframe 或捕获替身。
test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page, pwa }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(({ key, marker }) => {
    if (sessionStorage.getItem(marker)) return;
    localStorage.setItem(key, "320");
    localStorage.setItem("pi-reach-sidebar-collapsed", "false");
    sessionStorage.setItem(marker, "true");
  }, { key: WIDTH_KEY, marker: SEED_MARKER });
  await pwa.open();
  await expect(separator(page)).toHaveAttribute("aria-valuenow", "320");
});

async function beginDrag(page: Page) {
  const grip = separator(page);
  const box = await grip.boundingBox();
  expect(box).not.toBeNull();
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await expect.poll(() => grip.evaluate((node) => node.hasPointerCapture(1))).toBe(true);
  return point;
}

async function storedWidth(page: Page) {
  return page.evaluate((key) => localStorage.getItem(key), WIDTH_KEY);
}

test("native drag follows immediately, clamps without collapsing, commits and resets", async ({ page }) => {
  const grip = separator(page);
  const point = await beginDrag(page);
  await page.mouse.move(point.x + 24, point.y);
  await expect(grip).toHaveAttribute("aria-valuenow", "344");
  await expect.poll(() => storedWidth(page)).toBe("320");
  await page.mouse.move(point.x + 600, point.y);
  await expect(grip).toHaveAttribute("aria-valuenow", "360");
  await page.mouse.move(point.x - 200, point.y);
  await expect(grip).toHaveAttribute("aria-valuenow", "240");
  await expect(page.locator(".pwa-root")).not.toHaveAttribute("data-sidebar-collapsed");
  await page.mouse.up();
  await expect.poll(() => storedWidth(page)).toBe("240");
  await expect.poll(() => grip.evaluate((node) => node.hasPointerCapture(1))).toBe(false);
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe("");
  await grip.dblclick();
  await expect(grip).toHaveAttribute("aria-valuenow", "280");
  await expect.poll(() => storedWidth(page)).toBe("280");
});

for (const reason of ["Escape", "lostcapture", "blur", "hidden", "collapse", "settings", "mobile"] as const) {
  test(`native drag cancels on ${reason} and restores capture, preference and body styles`, async ({ page }) => {
    const grip = separator(page);
    await page.evaluate(() => {
      document.body.style.setProperty("cursor", "crosshair", "important");
      document.body.style.setProperty("user-select", "text", "important");
    });
    const point = await beginDrag(page);
    await page.mouse.move(point.x + 24, point.y);
    await expect(grip).toHaveAttribute("aria-valuenow", "344");
    if (reason === "Escape") await page.keyboard.press("Escape");
    if (reason === "lostcapture") await grip.evaluate((node) => node.releasePointerCapture(1));
    if (reason === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    if (reason === "hidden") await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    if (reason === "collapse") await page.locator(".pwa-sidebar-toggle").evaluate((node: HTMLButtonElement) => node.click());
    if (reason === "settings") await page.locator(".pwa-nav-settings").evaluate((node: HTMLButtonElement) => node.click());
    if (reason === "mobile") await page.setViewportSize({ width: 390, height: 844 });
    // 原生 lostpointercapture 在下一次指针分发前处理，不用计时器模拟通知。
    await page.mouse.move(point.x + 40, point.y);
    await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe("crosshair");
    expect(await page.evaluate(() => [document.body.style.getPropertyPriority("cursor"), document.body.style.userSelect, document.body.style.getPropertyPriority("user-select")])).toEqual(["important", "text", "important"]);
    await expect.poll(() => grip.evaluate((node) => node.hasPointerCapture(1))).toBe(false);
    await page.mouse.up();
    await expect.poll(() => storedWidth(page)).toBe("320");
    if (reason === "mobile") {
      await expect(grip).toBeHidden();
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    if (reason === "collapse") await page.locator(".pwa-sidebar-toggle").click();
    if (reason === "settings") {
      await page.locator(".pwa-settings-back").click();
      await expect(page.locator(".pwa-settings-view")).toHaveCount(0);
    }
    await expect(grip).toHaveAttribute("aria-valuenow", "320");
  });
}

test("keyboard preference survives reload, temporary caps and stationary native press", async ({ page }) => {
  const grip = separator(page);
  await grip.focus();
  await page.keyboard.press("End");
  await expect(grip).toHaveAttribute("aria-valuenow", "360");
  await page.reload();
  await expect(grip).toHaveAttribute("aria-valuenow", "360");
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(grip).toHaveAttribute("aria-valuenow", "276");
  await expect(grip).toHaveAttribute("aria-valuemax", "276");
  await beginDrag(page);
  await page.mouse.up();
  await expect.poll(() => storedWidth(page)).toBe("360");
  await grip.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("End");
  await expect.poll(() => storedWidth(page)).toBe("360");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(grip).toHaveAttribute("aria-valuenow", "360");
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(grip).toHaveAttribute("aria-valuenow", "276");
  await grip.dblclick();
  await expect(grip).toHaveAttribute("aria-valuenow", "276");
  await expect.poll(() => storedWidth(page)).toBe("280");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(grip).toHaveAttribute("aria-valuenow", "280");
});
