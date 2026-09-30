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

const serwist: Serwist = new Serwist({
  cacheId: "pi-reach",
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: false,
  clientsClaim: false,
  runtimeCaching: [
    {
      matcher: isAppNavigation,
      handler: new NetworkFirst({
        cacheName: "pi-reach-app",
        networkTimeoutSeconds: 5,
        plugins: [{
          // 离线或安装后打开未缓存的子路径（如 /app/settings）时回退到预缓存的 /app。
          handlerDidError: async (): Promise<Response | undefined> => (await serwist.matchPrecache("/app")) ?? undefined,
        }],
      }),
    },
    {
      matcher: isStaticAsset,
      handler: new CacheFirst({ cacheName: "pi-reach-static" }),
    },
    {
      matcher: isDynamicRequest,
      handler: new NetworkOnly(),
    },
  ],
});

serwist.addEventListeners();
