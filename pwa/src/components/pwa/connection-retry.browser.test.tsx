import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PwaConnectionBanner } from "./pwa-app-actions";
import { PwaUiProvider } from "./pwa-ui-provider";

afterEach(async () => { await page.viewport(1280, 900); });

test.each([{ width: 1280, height: 900 }, { width: 390, height: 844 }])("keeps retry visible, keyboard accessible and inside the banner at $width", async ({ width, height }) => {
  await page.viewport(width, height);
  const onRetry = vi.fn();
  const screen = await render(<PwaUiProvider><div className="pwa-root"><PwaConnectionBanner kind="relay" connection="retrying" onRetry={onRetry} /></div></PwaUiProvider>);
  try {
    const retry = screen.getByRole("button", { name: "Retry now" });
    await expect.element(retry).toBeVisible();
    const button = retry.element();
    const rect = button.getBoundingClientRect();
    const banner = document.querySelector(".pwa-connection-banner")!.getBoundingClientRect();
    expect(rect.width).toBeGreaterThanOrEqual(44);
    expect(rect.height).toBeGreaterThanOrEqual(44);
    expect(rect.left).toBeGreaterThanOrEqual(banner.left);
    expect(rect.right).toBeLessThanOrEqual(banner.right);
    expect(rect.bottom).toBeLessThanOrEqual(banner.bottom);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    button.focus();
    await expect.element(retry).toHaveFocus();
    await retry.click();
    expect(onRetry).toHaveBeenCalledOnce();
  } finally { await screen.unmount(); }
});

test.each(["connecting", "no_network"] as const)("does not submit a retry while %s", async (connection) => {
  const onRetry = vi.fn();
  const screen = await render(<PwaUiProvider><PwaConnectionBanner kind={connection === "no_network" ? "network" : "relay"} connection={connection} onRetry={onRetry} /></PwaUiProvider>);
  try {
    const retry = screen.getByRole("button", { name: "Retry now" });
    await expect.element(retry).toBeVisible();
    await expect.element(retry).toBeDisabled();
    (retry.element() as HTMLButtonElement).click();
    expect(onRetry).not.toHaveBeenCalled();
  } finally { await screen.unmount(); }
});
