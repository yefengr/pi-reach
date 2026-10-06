import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { CacheFirst, NetworkFirst, NetworkOnly, Serwist } from "serwist";

// Serwist replaces this placeholder with the production asset manifest.
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// 产品路由均位于 /app 下；子路径导航与 /app 使用同一应用入口。
const isAppNavigation = ({ request, sameOrigin, url }: { request: Request; sameOrigin: boolean; url: URL }) =>
  sameOrigin && request.mode === "navigate" && (url.pathname === "/app" || url.pathname.startsWith("/app/"));

const isStaticAsset = ({ request, sameOrigin, url }: { request: Request; sameOrigin: boolean; url: URL }) =>
  sameOrigin &&
  request.method === "GET" &&
  (url.pathname.startsWith("/assets/") ||
    url.pathname === "/icon.svg" ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/logo.svg" ||
    url.pathname === "/app-icon-192.png" ||
    url.pathname === "/app-icon-512.png" ||
    url.pathname === "/apple-touch-icon.png");

const isDynamicRequest = ({ sameOrigin }: { sameOrigin: boolean }) => sameOrigin;
const appUrl = new URL("/app", self.location.origin).href;
const entries = self.__SW_MANIFEST;
const appEntry = entries?.find((entry): entry is PrecacheEntry => typeof entry !== "string" && entry.url === "app");
// 旧 SW 的导航缓存不携带运行时配置；新构建也不读取上一个构建的导航 HTML。
const appCacheName = `pi-reach-runtime-app-${appEntry?.revision ?? "unversioned"}`;

const serwist = new Serwist({
  cacheId: "pi-reach",
  precacheEntries: entries,
  precacheOptions: {
    cacheName: "pi-reach-runtime-precache",
    plugins: [{
      // HTML revision 来自构建，但正文由容器注入；每次安装重新获取 /app。
      cachedResponseWillBeUsed: async ({ request, event, cachedResponse }) =>
        event.type === "install" && new URL(request.url).pathname === "/app" ? undefined : cachedResponse,
      requestWillFetch: async ({ request }) => new URL(request.url).pathname === "/app"
        ? new Request(request, { cache: "reload" }) : request,
    }],
  },
  skipWaiting: false,
  clientsClaim: false,
});

// Serwist 默认先注册 precache route。导航须 NetworkFirst，不能被 /app 的预缓存短路。
const precacheRoutes = [...(serwist.routes.get("GET") ?? [])];
for (const route of precacheRoutes) serwist.unregisterRoute(route);
serwist.registerCapture(isAppNavigation, new NetworkFirst({
  cacheName: appCacheName,
  networkTimeoutSeconds: 5,
  plugins: [{
    // 所有导航使用同一入口；最新在线 HTML 也作为未知子路径的离线入口。
    cacheKeyWillBeUsed: async () => appUrl,
    handlerDidError: async (): Promise<Response | undefined> => (await serwist.matchPrecache("/app")) ?? undefined,
  }],
}));
for (const route of precacheRoutes) serwist.registerRoute(route);
serwist.registerCapture(isStaticAsset, new CacheFirst({ cacheName: "pi-reach-static" }));
serwist.registerCapture(isDynamicRequest, new NetworkOnly());

// 接管时用本次安装的入口覆盖导航缓存，避免升级交接复用旧环境 metadata。
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const response = await serwist.matchPrecache("/app");
    if (!response) throw new Error("missing_runtime_app_precache");
    await (await caches.open(appCacheName)).put(appUrl, response);
  })());
});
serwist.addEventListeners();
