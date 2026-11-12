import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ColorSchemeScript } from "@mantine/core";
import react from "@vitejs/plugin-react";
import { serwist } from "@serwist/vite";
import { defineConfig } from "vite";
import { pwaRoutingPlugin } from "./scripts/pwa-routing.mjs";
import { startupImageLinks } from "./scripts/startup-images.mjs";
import { APPEARANCE_STORAGE_KEY, DARK_SCHEME_QUERY, DARK_THEME_COLOR, LIGHT_THEME_COLOR } from "./src/lib/ui/appearance.ts";

// 复用 Mantine 已恢复的外观；存储不可用时与 CSS 一样退回系统偏好。
const themeColorScript = `(() => {
  const scheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  const dark = scheme === "dark" || (scheme !== "light" && window.matchMedia(${JSON.stringify(DARK_SCHEME_QUERY)}).matches);
  const color = dark ? ${JSON.stringify(DARK_THEME_COLOR)} : ${JSON.stringify(LIGHT_THEME_COLOR)};
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => { meta.content = color; });
})();`;

export default defineConfig(({ command }) => ({
  base: "/",
  appType: "mpa",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [
    react(),
    pwaRoutingPlugin(),
    {
      name: "pwa-appearance-boot",
      transformIndexHtml(html) {
        // 使用 Mantine 原生脚本和同一存储键，在首屏绘制前恢复外观。
        const colorSchemeScript = renderToStaticMarkup(createElement(ColorSchemeScript, {
          defaultColorScheme: "auto",
          localStorageKey: APPEARANCE_STORAGE_KEY,
        }));
        // iOS 启动图按设备尺寸、方向与深浅外观逐条声明，链接由同一份设备清单生成。
        return html
          .replace("<!-- color-scheme -->", `${colorSchemeScript}<script>${themeColorScript}</script>`)
          .replace("<!-- startup-images -->", startupImageLinks());
      },
    },
    serwist({
      disable: command !== "build",
      swSrc: "src/app/sw.ts",
      swDest: "sw.js",
      globDirectory: "dist",
      globPatterns: ["**/*.{html,js,css,woff,woff2,png,svg,webmanifest}"],
      // 启动图只在 iOS 添加到主屏幕时下载一次，不进入每个客户端的预缓存。
      globIgnores: ["sw.js", "**/*.map", "startup/**"],
      injectionPoint: "self.__SW_MANIFEST",
      rollupFormat: "iife",
      scope: "/app",
      manifestTransforms: [async (entries) => ({
        // 静态服务器只通过 /app 提供页面；离线缓存必须使用实际访问地址。
        manifest: entries.map((entry) => entry.url === "index.html" ? { ...entry, url: "app" } : entry),
        warnings: [],
      })],
    }),
  ],
  server: { host: "0.0.0.0", port: 3000, strictPort: true },
  build: { outDir: "dist", target: "es2022" },
}));
