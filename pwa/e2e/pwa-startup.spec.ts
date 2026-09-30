import { test, expect } from "./fixtures/pwa";

test("redirects the root route to the PWA", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "No computers paired yet" })).toBeVisible();
});

test("boots offline with system fonts after a fresh service worker installation", async ({ context, page, pwa }) => {
  const errors: string[] = [];
  const requestedUrls: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requestedUrls.push(request.url()));

  await pwa.open();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect(page).toHaveTitle("Pi Reach App");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");

  // 新安装的 worker 不接管当前页；下一次离线导航必须能直接打开预缓存页面。
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "No computers paired yet" })).toBeVisible();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  // 界面只使用系统字体栈，不下载任何字体文件。
  expect(requestedUrls.filter((url) => /\.(?:woff2?|ttf|otf)(?:\?|$)/.test(url))).toEqual([]);
  expect(requestedUrls.filter((url) => /fonts\.(?:googleapis|gstatic)\.com|\/_next\//.test(url))).toEqual([]);
  expect(errors).toEqual([]);
});

test("opens an empty PWA without horizontal overflow and activates the app service worker", async ({ context, page, pwa }) => {
  const serviceWorker = context.waitForEvent("serviceworker");

  await pwa.open();

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("status")).toHaveCount(0);
  const dimensions = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

  const worker = await serviceWorker;
  expect(new URL(worker.url()).pathname).toBe("/sw.js");
  await expect.poll(async () => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/app");
    const readyRegistration = await navigator.serviceWorker.ready;
    return {
      activeState: registration?.active?.state,
      readyScope: readyRegistration.scope,
      scope: registration?.scope,
    };
  })).toEqual({
    activeState: "activated",
    readyScope: `${new URL(page.url()).origin}/app`,
    scope: `${new URL(page.url()).origin}/app`,
  });
});
