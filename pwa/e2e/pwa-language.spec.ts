import { test, expect } from "./fixtures/pwa";

test.describe("with a Chinese browser language", () => {
  test.use({ locale: "zh-CN" });

  test("shows the interface in Simplified Chinese without horizontal overflow", async ({ page, pwa }) => {
    await pwa.open();

    await expect(page.getByRole("heading", { name: "还没有配对的电脑" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    const dimensions = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  });

  test("keeps a stored English choice over the browser language", async ({ page, pwa }) => {
    await page.addInitScript(() => window.localStorage.setItem("pi-reach-language", "en"));
    await pwa.open();

    await expect(page.getByRole("heading", { name: "No computers paired yet" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });
});
