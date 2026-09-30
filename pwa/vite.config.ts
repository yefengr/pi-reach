import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ColorSchemeScript } from "@mantine/core";
import react from "@vitejs/plugin-react";
import { serwist } from "@serwist/vite";
import { defineConfig } from "vite";
import { pwaRoutingPlugin } from "./scripts/pwa-routing.mjs";
import { APPEARANCE_STORAGE_KEY } from "./src/lib/ui/appearance.ts";

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
        return html.replace("<!-- color-scheme -->", renderToStaticMarkup(createElement(ColorSchemeScript, {
          defaultColorScheme: "auto",
          localStorageKey: APPEARANCE_STORAGE_KEY,
        })));
      },
    },
    serwist({
      disable: command !== "build",
      swSrc: "src/app/sw.ts",
      swDest: "sw.js",
      globDirectory: "dist",
      globPatterns: ["**/*.{html,js,css,woff,woff2,png,svg,webmanifest}"],
      globIgnores: ["sw.js", "**/*.map"],
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
