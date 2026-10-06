import { createServer } from "node:http";
import { test, expect } from "./fixtures/pwa";

const META_PATTERN = /<meta name="pi-reach-default-relay-url" content="[^"]*"\s*\/?>/;
const LEGACY_WORKER = `
self.addEventListener('install', event => event.waitUntil((async () => {
  await (await caches.open('pi-reach-app')).put('/app', await fetch('/app'));
})()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate' && new URL(event.request.url).pathname.startsWith('/app')) {
    event.respondWith(caches.open('pi-reach-app').then(cache => cache.match('/app')));
  }
});`;

/** 复用已启动的生产 preview，只在独立 localhost origin 模拟容器入口注入与旧 SW。 */
async function runtimePreview(upstream: string, relayUrl: string, legacyWorker = false) {
  const state = { relayUrl, legacyWorker };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", upstream);
      if (url.pathname === "/sw.js" && state.legacyWorker) {
        response.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-cache" });
        response.end(LEGACY_WORKER);
        return;
      }
      const result = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
      const headers: Record<string, string> = {};
      for (const name of ["content-type", "cache-control", "location"]) {
        const value = result.headers.get(name);
        if (value) headers[name] = value;
      }
      let body = Buffer.from(await result.arrayBuffer());
      if (headers["content-type"]?.startsWith("text/html")) {
        const content = state.relayUrl.replaceAll("&", "&amp;").replaceAll("'", "&#39;");
        body = Buffer.from(body.toString().replace(META_PATTERN, `<meta name="pi-reach-default-relay-url" content="${content}" />`));
      }
      response.writeHead(result.status, headers);
      response.end(body);
    })().catch(() => { response.writeHead(502); response.end("Runtime preview failed"); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing runtime preview address");
  return {
    state,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
      server.closeAllConnections();
    }),
  };
}

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

test("preserves each injected environment on fresh offline startup and settings fallback", async ({ baseURL, context, page }) => {
  test.setTimeout(60_000);
  if (!baseURL) throw new Error("Missing preview URL");
  for (const relayUrl of ["http://127.0.0.1:9/production/ws", "http://127.0.0.1:9/staging/ws?tenant=one&region=two"]) {
    const preview = await runtimePreview(baseURL, relayUrl);
    try {
      await context.setOffline(false);
      await page.goto(`${preview.origin}/app`);
      await expect(page.getByRole("heading", { name: "No computers paired yet" })).toBeVisible();
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      await context.setOffline(true);
      await page.reload();
      await expect(page.getByRole("heading", { name: "No computers paired yet" })).toBeVisible();
      await expect(page.locator('meta[name="pi-reach-default-relay-url"]')).toHaveAttribute("content", relayUrl);
      await page.goto(`${preview.origin}/app/settings?offline=uncached`);
      const input = page.getByRole("textbox", { name: "Relay URL" });
      await expect(input).toHaveValue(relayUrl);
      await expect(input).toHaveAttribute("placeholder", relayUrl);
      await input.fill("");
      await page.getByRole("button", { name: "Save settings" }).click();
      await page.reload();
      await expect(input).toHaveValue(relayUrl);
    } finally {
      await context.setOffline(false);
      await preview.close();
    }
  }
});

test("hands off a legacy same-origin worker without reusing its old environment HTML", async ({ baseURL, context, page }) => {
  test.setTimeout(60_000);
  if (!baseURL) throw new Error("Missing preview URL");
  const oldRelay = "http://127.0.0.1:9/legacy-production";
  const nextRelay = "http://127.0.0.1:9/staging/ws?tenant=public";
  const preview = await runtimePreview(baseURL, oldRelay, true);
  try {
    await page.goto(`${preview.origin}/app`);
    await expect(page.getByRole("heading", { name: "No computers paired yet" })).toBeVisible();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await expect(page.locator('meta[name="pi-reach-default-relay-url"]')).toHaveAttribute("content", oldRelay);
    preview.state.relayUrl = nextRelay;
    preview.state.legacyWorker = false;
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/app");
      if (!registration) throw new Error("Missing legacy worker");
      await registration.update();
    });
    await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration("/app"))?.waiting))).toBe(true);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/app");
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
        registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
      });
    });
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/app"))?.active?.state), { timeout: 15_000 }).toBe("activated");
    await context.setOffline(true);
    await page.goto(`${preview.origin}/app/settings?after-upgrade=uncached`);
    await expect(page.locator('meta[name="pi-reach-default-relay-url"]')).toHaveAttribute("content", nextRelay);
    await expect(page.getByRole("textbox", { name: "Relay URL" })).toHaveValue(nextRelay);
  } finally {
    await context.setOffline(false);
    await preview.close();
  }
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
