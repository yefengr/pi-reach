import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaOperationNotifications } from "./pwa-operation-notifications";
import { createOperationNotificationController, operationFeedbackMessage, type OperationNotificationController } from "@/lib/pwa/operation-notifications";

function Harness({ controller }: { controller: OperationNotificationController }) {
  const [revision, setRevision] = useState(0);
  return <PwaUiProvider><div className="pwa-root">
    <div className="pwa-layout"><main className="pwa-main">
      <header className="pwa-title-bar"><button onClick={() => setRevision(revision + 1)}>Rerender {revision}</button></header>
      <div className="pwa-main-notices" />
      <div className="pwa-message-list" style={{ height: 200, flex: "0 0 200px" }}><div style={{ height: 1200 }}>Reading position</div></div>
      <textarea className="pwa-composer-input" aria-label="Draft" />
      <PwaOperationNotifications controller={controller} />
    </main></div>
  </div></PwaUiProvider>;
}

afterEach(() => { vi.useRealTimers(); });

test("portals one floating card under the title area, preserves focus and reading, and occupies no space when empty", async () => {
  const controller = createOperationNotificationController();
  const screen = await render(<Harness controller={controller} />);
  try {
    const roots = document.querySelectorAll<HTMLElement>('.pwa-operation-notifications');
    // Mantine 一个实例生成六个位置 group，只有 top-center 可以包含通知。
    expect(roots).toHaveLength(6);
    // Toast 挂在 PWA 根节点上，作为最顶层浮层显示在会话标题区下方。
    expect([...roots].every((root) => root.parentElement === document.querySelector(".pwa-root"))).toBe(true);
    expect([...roots].every((root) => root.getBoundingClientRect().height === 0)).toBe(true);
    const draft = screen.getByRole("textbox", { name: "Draft" });
    await draft.fill("Keep this draft");
    draft.element().focus();
    const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
    list.scrollTop = 150;
    controller.show("model_set-error");
    await expect.element(screen.getByText(operationFeedbackMessage("model_set-error"))).toBeVisible();
    await expect.element(draft).toHaveFocus();
    expect(list.scrollTop).toBe(150);
    expect(document.querySelectorAll(".pwa-operation-notification")).toHaveLength(1);
    const notice = document.querySelector<HTMLElement>(".pwa-operation-notification")!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.getAttribute("aria-live")).toBe("polite");
    // 顶部居中、最大宽 400，位于最顶层且不占文档流。
    const root = notice.closest<HTMLElement>(".pwa-operation-notifications")!;
    expect(getComputedStyle(root).zIndex).toBe("400");
    expect(getComputedStyle(root).position).toBe("absolute");
    // 位于 48px 顶栏下方 8px。
    await expect.poll(() => notice.getBoundingClientRect().top).toBeGreaterThanOrEqual(56);
    const box = notice.getBoundingClientRect();
    expect(box.width).toBeLessThanOrEqual(400);
    expect(box.left + box.width / 2).toBeCloseTo(document.querySelector(".pwa-root")!.getBoundingClientRect().width / 2, 0);
    controller.show("registry-save");
    await expect.element(screen.getByText(operationFeedbackMessage("registry-save"))).toBeVisible();
    expect(document.querySelector(".pwa-operation-notification")).toBe(notice);
    expect(controller.store.getState().queue).toEqual([]);
    const close = screen.getByRole("button", { name: "Dismiss operation notification" });
    close.element().focus();
    await close.click();
    await expect.poll(() => document.querySelector(".pwa-operation-notification")).toBeNull();
    await expect.element(draft).toHaveFocus();
    expect(list.scrollTop).toBe(150);
    await expect.element(draft).toHaveValue("Keep this draft");
    expect([...roots].every((root) => root.getBoundingClientRect().height === 0)).toBe(true);
    await screen.getByRole("button", { name: "Rerender 0" }).click();
    expect(document.querySelector(".pwa-operation-notification")).toBeNull();
    controller.show("model_set-error");
    await expect.element(screen.getByText(operationFeedbackMessage("model_set-error"))).toBeVisible();
  } finally { await screen.unmount(); }
});

test("does not auto-close, consume Escape, or dismiss through horizontal wheel or drag", async () => {
  const controller = createOperationNotificationController();
  const screen = await render(<Harness controller={controller} />);
  try {
    vi.useFakeTimers();
    controller.show("thinking_set-error");
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    const message = screen.getByText(operationFeedbackMessage("thinking_set-error"));
    await expect.element(message).toBeVisible();
    const card = document.querySelector<HTMLElement>(".pwa-operation-notification")!;
    card.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    const wheel = new WheelEvent("wheel", { deltaX: 900, deltaY: 0, bubbles: true, cancelable: true });
    card.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    for (const [type, clientX] of [["pointerdown", 100], ["pointermove", 600], ["pointerup", 600]] as const) {
      card.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "touch", clientX, clientY: 100, bubbles: true }));
    }
    await userEvent.keyboard("{Escape}");
    await expect.element(message).toBeVisible();
    expect(getComputedStyle(card).getPropertyValue("--notifications-swipe-offset")).toBe("0px");
    expect(controller.store.getState().notifications).toHaveLength(1);
    expect(controller.store.getState().queue).toEqual([]);
  } finally { vi.useRealTimers(); await screen.unmount(); }
});

test("unmount clears the store and late callbacks cannot recreate a notification", async () => {
  const controller = createOperationNotificationController();
  const screen = await render(<Harness controller={controller} />);
  controller.show("registry-save");
  await expect.element(screen.getByText(operationFeedbackMessage("registry-save"))).toBeVisible();
  await screen.unmount();
  controller.show("model_set-error");
  expect(controller.store.getState().notifications).toEqual([]);
  expect(document.querySelector(".pwa-operation-notification")).toBeNull();
});

test("plain toasts close after four seconds unless hovered, and wait behind an error", async () => {
  const controller = createOperationNotificationController();
  const screen = await render(<Harness controller={controller} />);
  try {
    controller.notify("Settings saved");
    const message = screen.getByText("Settings saved");
    await expect.element(message).toBeVisible();
    const card = document.querySelector<HTMLElement>(".pwa-operation-notification")!;
    expect(card.classList.contains("pwa-toast-success")).toBe(true);
    card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 4_300));
    await expect.element(message).toBeVisible();
    card.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    await expect.poll(() => document.querySelector(".pwa-operation-notification"), { timeout: 6_000 }).toBeNull();

    controller.show("registry-save");
    controller.notify("Connection restored");
    await expect.element(screen.getByText(operationFeedbackMessage("registry-save"))).toBeVisible();
    await expect.element(screen.getByText("Connection restored")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Dismiss operation notification" }).click();
    await expect.element(screen.getByText("Connection restored")).toBeVisible();
  } finally { await screen.unmount(); }
}, 20_000);

test("toast actions keep a 44px touch target without growing the card", async () => {
  const controller = createOperationNotificationController();
  const screen = await render(<Harness controller={controller} />);
  try {
    controller.notify("Settings saved");
    await expect.element(screen.getByText("Settings saved")).toBeVisible();
    const plainHeight = document.querySelector<HTMLElement>(".pwa-operation-notification")!.getBoundingClientRect().height;
    controller.notify("New version available", { action: { label: "Refresh", onClick: () => {} } });
    const action = screen.getByRole("button", { name: "Refresh" });
    await expect.element(action).toBeVisible();
    expect(Math.round(action.element().getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(getComputedStyle(action.element(), "::before").top).toBe("4px");
    const card = document.querySelector<HTMLElement>(".pwa-operation-notification")!;
    expect(Math.round(card.getBoundingClientRect().height)).toBe(Math.round(plainHeight));
  } finally { await screen.unmount(); }
});
