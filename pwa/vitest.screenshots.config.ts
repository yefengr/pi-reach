// README 截图生成配置，入口为 `pnpm screenshots`；不属于 `pnpm test`。
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: ["@mantine/hooks"] },
  resolve: { alias: [{ find: /^@\//, replacement: `${src}/` }] },
  // 截图写入仓库根的 docs/assets/。
  server: { fs: { allow: [repositoryRoot] } },
  test: {
    include: ["src/test/screenshots/**/*.screenshot.tsx"],
    setupFiles: ["src/test/browser/setup.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
    browser: {
      enabled: true,
      provider: playwright({ contextOptions: { deviceScaleFactor: 2 } }),
      headless: true,
      instances: [{ browser: "chromium", viewport: { width: 1440, height: 900 } }],
    },
  },
});
