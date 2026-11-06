import type { ComponentProps } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { finishCssTransitions } from "@/test/browser/motion";
import { MessageComposer } from "./message-composer";
import { PwaUiProvider } from "./pwa-ui-provider";
import { ConnectionIssueWorkspace } from "./workspace-content";

const noop = () => {};
const composerProps: ComponentProps<typeof MessageComposer> = {
  enterSends: true, attachments: [], canAttach: false, sendingAttachments: false,
  isOnline: false, isWorking: false, stopping: false, draft: "",
  onDraftChange: noop, onSend: noop, onStop: noop, onAddFiles: noop,
  onRemoveAttachment: noop, onRetryAttachment: noop,
  commandModels: [], commandCurrentModel: null, commandCurrentModelFallback: null,
  commandThinking: "off", commandPendingAction: null,
  onNewSession: noop, onCompactSession: noop, onSetModel: noop,
  onSetThinking: noop, onCommandsOpen: noop,
};

afterEach(async () => { await page.viewport(1280, 900); });

// 断线 10 秒后，「立即重试」放在输入框卡片顶部的提示行（ADR-20261105）。
test.each([{ width: 1280, height: 900 }, { width: 390, height: 844 }])("keeps the hint-line retry visible, keyboard accessible and inside the card at $width", async ({ width, height }) => {
  await page.viewport(width, height);
  const onRetry = vi.fn();
  const hint = { text: "Can't reach Relay. Retrying automatically…", tone: "neutral" as const, busy: true, action: { label: "Retry now", onAction: onRetry } };
  const screen = await render(<PwaUiProvider><div className="pwa-root"><div className="pwa-chat-footer" style={{ position: "fixed", right: 0, bottom: 0, left: 0 }}><MessageComposer {...composerProps} connectionHint={hint} /></div></div></PwaUiProvider>);
  try {
    await finishCssTransitions();
    const retry = screen.getByRole("button", { name: "Retry now" });
    await expect.element(retry).toBeVisible();
    const button = retry.element();
    const rect = button.getBoundingClientRect();
    const card = document.querySelector(".pwa-composer-card")!.getBoundingClientRect();
    expect(rect.width).toBeGreaterThanOrEqual(44);
    expect(rect.height).toBeGreaterThanOrEqual(44);
    expect(rect.left).toBeGreaterThanOrEqual(card.left);
    expect(rect.right).toBeLessThanOrEqual(card.right);
    // 提示行裁切时上下各外扩 10，越出行高的点击区仍可命中。
    for (const y of [rect.top + 2, rect.top + rect.height / 2, rect.bottom - 2]) {
      expect(button.contains(document.elementFromPoint(rect.left + rect.width / 2, y))).toBe(true);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    button.focus();
    await expect.element(retry).toHaveFocus();
    await retry.click();
    expect(onRetry).toHaveBeenCalledOnce();
  } finally { await screen.unmount(); }
});

test("does not submit a disabled hint-line retry", async () => {
  const onRetry = vi.fn();
  const hint = { text: "Can't reach Relay. Retrying automatically…", tone: "neutral" as const, busy: true, action: { label: "Retry now", onAction: onRetry, disabled: true } };
  const screen = await render(<PwaUiProvider><div className="pwa-root"><MessageComposer {...composerProps} connectionHint={hint} /></div></PwaUiProvider>);
  try {
    const retry = screen.getByRole("button", { name: "Retry now" });
    await expect.element(retry).toBeVisible();
    await expect.element(retry).toBeDisabled();
    (retry.element() as HTMLButtonElement).click();
    expect(onRetry).not.toHaveBeenCalled();
  } finally { await screen.unmount(); }
});

test("retries from the main empty state when no session is open", async () => {
  const onRetry = vi.fn();
  const screen = await render(<PwaUiProvider><div className="pwa-root"><ConnectionIssueWorkspace kind="relay" stage="retry" busy onRetry={onRetry} retryDisabled={false} /></div></PwaUiProvider>);
  try {
    const retry = screen.getByRole("button", { name: "Retry now" });
    await expect.element(retry).toBeVisible();
    expect(retry.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(36);
    await retry.click();
    expect(onRetry).toHaveBeenCalledOnce();
  } finally { await screen.unmount(); }
});
