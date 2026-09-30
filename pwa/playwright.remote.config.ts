import { defineConfig, devices } from "playwright/test";

function resolvePort(): number {
  const rawPort = process.env.PLAYWRIGHT_REMOTE_E2E_PORT ?? "3102";
  if (!/^\d+$/.test(rawPort)) throw new Error("PLAYWRIGHT_REMOTE_E2E_PORT must be a numeric TCP port.");

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PLAYWRIGHT_REMOTE_E2E_PORT must be between 1 and 65535.");
  }
  return port;
}

const port = resolvePort();
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e/real",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  outputDir: "test-results/remote",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/remote" }]],
  use: {
    baseURL,
    serviceWorkers: "block",
    trace: "off",
    screenshot: "off",
    launchOptions: {
      args: ["--host-resolver-rules=MAP pi-reach-relay.yefengr.cn ~NOTFOUND, MAP relay-pi.yefengr.cn ~NOTFOUND"],
    },
  },
  projects: [
    {
      name: "remote-desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
  webServer: [
    {
      command: "../docker/e2e/scripts/browser-up.sh",
      url: "http://127.0.0.1:18787/health",
      reuseExistingServer: false,
      timeout: 300_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
    },
    {
      command: "pnpm build && pnpm start:e2e-server",
      url: `${baseURL}/app`,
      reuseExistingServer: false,
      timeout: 180_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      env: {
        ...process.env,
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
        PORT: String(port),
      },
    },
  ],
});
