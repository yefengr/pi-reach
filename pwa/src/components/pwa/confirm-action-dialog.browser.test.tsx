import { useState } from "react";
import { beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { SettingsConfirmHarness, SessionConfirmHarness } from "@/test/browser/fixtures/confirm-action-overlays";
import { ConfirmActionDialog, type ConfirmActionDialogAction } from "./confirm-action-dialog";

type ConfirmHarnessProps = {
  action?: ConfirmActionDialogAction;
  onConfirm: () => Promise<void>;
};

function ConfirmHarness({ action: nextAction = { kind: "new-session" }, onConfirm }: ConfirmHarnessProps) {
  const [action, setAction] = useState<ConfirmActionDialogAction | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = () => {
    if (pending) return;
    setPending(true);
    setError(null);
    void onConfirm()
      .then(() => setAction(null))
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Confirmation failed.");
      })
      .finally(() => setPending(false));
  };

  return (
    <>
      <button type="button" onClick={() => { setError(null); setAction(nextAction); }}>
        Open confirmation
      </button>
      <ConfirmActionDialog
        action={action}
        pending={pending}
        error={error}
        onConfirm={confirm}
        onClose={() => setAction(null)}
      />
    </>
  );
}

const noOpConfirm = async () => {};

beforeEach(async () => {
  await page.viewport(1280, 900);
});

async function openConfirmation(action?: ConfirmActionDialogAction, onConfirm = noOpConfirm) {
  const screen = await renderPwa(<ConfirmHarness action={action} onConfirm={onConfirm} />);
  const trigger = screen.getByRole("button", { name: "Open confirmation" });
  await trigger.click();
  const dialog = screen.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  return { screen, trigger, dialog };
}

test("keeps one mounted dialog instance through closed, open, and closed states", async () => {
  const screen = await renderPwa(<ConfirmHarness onConfirm={noOpConfirm} />);
  const dialog = screen.getByRole("dialog");
  const trigger = screen.getByRole("button", { name: "Open confirmation" });

  await expect.element(dialog).not.toBeInTheDocument();
  await trigger.click();
  await expect.element(dialog).toBeVisible();
  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
});

test("renders an accessible dialog and closes through Cancel and Escape", async () => {
  const { screen, dialog } = await openConfirmation();

  await expect.element(dialog).toHaveAttribute("aria-modal", "true");
  const dialogElement = dialog.element();
  const labelledBy = dialogElement.getAttribute("aria-labelledby");
  expect(labelledBy).toBeTruthy();
  expect(document.getElementById(labelledBy!)?.textContent).toContain("Start a fresh session?");
  const describedBy = dialogElement.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  expect(document.getElementById(describedBy!)?.textContent).toContain("Everyone viewing this Pi will move to a fresh conversation.");
  await expect.element(screen.getByRole("heading", { name: "Start a fresh session?", exact: true })).toBeVisible();
  await expect.element(screen.getByText("Everyone viewing this Pi will move to a fresh conversation.")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Start fresh session" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Close confirmation dialog" })).toBeVisible();

  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();

  const trigger = screen.getByRole("button", { name: "Open confirmation" });
  await trigger.click();
  await expect.element(dialog).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
});

test("traps focus in the dialog and returns it to the explicit trigger after closing", async () => {
  const screen = await renderPwa(<ConfirmHarness onConfirm={noOpConfirm} />);
  const trigger = screen.getByRole("button", { name: "Open confirmation" });
  trigger.element().focus();
  await expect.element(trigger).toHaveFocus();

  await trigger.click();
  const dialog = screen.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await expect.poll(() => dialog.element().contains(document.activeElement)).toBe(true);
  await userEvent.tab();
  expect(dialog.element().contains(document.activeElement)).toBe(true);
  await userEvent.tab({ shift: true });
  expect(dialog.element().contains(document.activeElement)).toBe(true);

  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

test("locks every close path while confirmation is pending", async () => {
  let resolveConfirmation!: () => void;
  const pendingConfirmation = new Promise<void>((resolve) => {
    resolveConfirmation = resolve;
  });
  const { screen, dialog } = await openConfirmation({ kind: "clear-local-data" }, () => pendingConfirmation);

  await screen.getByRole("button", { name: "Clear local data" }).click();
  const pendingConfirm = screen.getByRole("button", { name: /Clearing local data/ });
  await expect.element(pendingConfirm).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Close confirmation dialog" })).toBeDisabled();

  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).toBeVisible();
  const overlay = document.querySelector<HTMLElement>(".mantine-Modal-overlay");
  expect(overlay).not.toBeNull();
  overlay!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await expect.element(dialog).toBeVisible();

  resolveConfirmation();
  await expect.element(dialog).not.toBeInTheDocument();
});

test("keeps the dialog open on error and permits a retry", async () => {
  let attempts = 0;
  const { screen, dialog } = await openConfirmation({ kind: "clear-local-data" }, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Storage is unavailable.");
  });

  await screen.getByRole("button", { name: "Clear local data" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Storage is unavailable.");
  await expect.element(dialog).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Clear local data" })).toBeEnabled();

  await screen.getByRole("button", { name: "Clear local data" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(attempts).toBe(2);
});

const LONG_PAIRING = `Studio Mac ${"with a very long local pairing name ".repeat(4)}`;
const confirmLayoutCases = [390, 1280].flatMap((width) => [
  { width, action: { kind: "new-session" } as ConfirmActionDialogAction, error: null },
  { width, action: { kind: "clear-local-data" } as ConfirmActionDialogAction, error: null },
  { width, action: { kind: "remove-pairing", label: LONG_PAIRING } as ConfirmActionDialogAction, error: null },
  { width, action: { kind: "remove-pairing", label: LONG_PAIRING } as ConfirmActionDialogAction, error: "The computer could not be reached. Check that it is online and try again." },
]);

test.each(confirmLayoutCases)("lays out the $action.kind confirmation at $width px (error: $error)", async ({ width, action, error }) => {
  await page.viewport(width, 844);
  const screen = await renderPwa(<ConfirmActionDialog action={action} pending={false} error={error} onConfirm={noOpConfirm} onClose={() => {}} />);
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  const content = document.querySelector<HTMLElement>(".pwa-confirm-dialog")!;
  if (width < 768) {
    await expect.poll(() => Math.round(content.getBoundingClientRect().left)).toBe(16);
    expect(Math.round(content.getBoundingClientRect().width)).toBe(width - 32);
  } else {
    await expect.poll(() => Math.round(content.getBoundingClientRect().width)).toBe(400);
  }
  await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
  const box = content.getBoundingClientRect();
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(844);
  expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth);
  const title = document.querySelector<HTMLElement>(".pwa-confirm-title")!;
  const close = document.querySelector<HTMLElement>(".pwa-confirm-head .pwa-icon-button")!.getBoundingClientRect();
  const description = document.querySelector<HTMLElement>(".pwa-confirm-description")!.getBoundingClientRect();
  const actions = document.querySelector<HTMLElement>(".pwa-confirm-actions")!.getBoundingClientRect();
  expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth);
  expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(close.left);
  expect(Math.round(description.top - title.getBoundingClientRect().bottom)).toBe(16);
  const errorBox = document.querySelector<HTMLElement>(".pwa-confirm-error")?.getBoundingClientRect();
  if (error) {
    expect(errorBox).toBeDefined();
    expect(errorBox!.top).toBeGreaterThanOrEqual(description.bottom);
    expect(actions.top - errorBox!.bottom).toBeGreaterThanOrEqual(16);
  } else {
    expect(errorBox).toBeUndefined();
    expect(Math.round(actions.top - description.bottom)).toBeGreaterThanOrEqual(16);
  }
});

test("applies the PWA mobile layout without clipping action content", async () => {
  await page.viewport(390, 844);
  const { screen, dialog } = await openConfirmation({ kind: "clear-local-data" });
  const dialogElement = dialog.element();
  const actions = document.querySelector<HTMLElement>(".pwa-confirm-actions");
  expect(actions).not.toBeNull();

  const dialogRect = dialogElement.getBoundingClientRect();
  expect(dialogRect.left).toBeGreaterThanOrEqual(0);
  expect(dialogRect.top).toBeGreaterThanOrEqual(0);
  expect(dialogRect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(dialogRect.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(dialogElement.scrollWidth).toBeLessThanOrEqual(dialogElement.clientWidth);
  expect(getComputedStyle(actions!).flexDirection).toBe("column");

  const buttons = [...actions!.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons).toHaveLength(2);
  expect(buttons[0].getBoundingClientRect().width).toBe(buttons[1].getBoundingClientRect().width);
  for (const button of buttons) {
    expect(button.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
  }

  await expect.element(screen.getByRole("heading", { name: "Clear this browser's Pi Reach identity, pairings, and history?", exact: true })).toBeVisible();
  await expect.element(screen.getByText("This cannot be undone.")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Clear local data" })).toBeVisible();
});

function locatorFor(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  return page.elementLocator(element!);
}

test("keeps the settings page under the confirmation Modal through Escape", async () => {
  const screen = await renderPwa(<SettingsConfirmHarness />);
  const drawer = locatorFor(".pwa-settings-page");
  const clearButton = screen.getByRole("button", { name: "Clear local data" }).first();
  await expect.element(drawer).toBeVisible();

  await clearButton.click();
  const dialog = locatorFor(".pwa-confirm-dialog");
  await expect.element(dialog).toBeVisible();
  const modalRoot = document.querySelector<HTMLElement>(".mantine-Modal-root");
  expect(modalRoot).not.toBeNull();
  expect(modalRoot!.closest(".pwa-root")).not.toBeNull();
  expect(getComputedStyle(modalRoot!).getPropertyValue("--mb-z-index")).toBe("310");

  const overlay = document.querySelector<HTMLElement>(".mantine-Modal-overlay");
  expect(overlay).not.toBeNull();
  overlay!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("settings-confirm-transition")).toHaveAttribute("data-state", "exited");
  await expect.element(drawer).toBeVisible();

  await clearButton.click();
  await expect.element(dialog).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("settings-confirm-transition")).toHaveAttribute("data-state", "exited");
  await expect.element(drawer).toBeVisible();
  await expect.element(clearButton).toHaveFocus();

  // 设置是独立页面，Escape 只关闭最上层弹窗，不离开设置页。
  await userEvent.keyboard("{Escape}");
  await expect.element(drawer).toBeVisible();
});

test("keeps navigation behind pairing confirmation and returns to its management trigger", async () => {
  const screen = await renderPwa(<SessionConfirmHarness />);
  const drawer = screen.getByRole("dialog", { name: /Workspace/ });
  const management = screen.getByRole("button", { name: "Choose computer, current office" });
  const requestDelete = async () => {
    await management.click();
    await screen.getByRole("button", { name: "Computer actions for office" }).click();
    await screen.getByRole("menuitem", { name: "Remove office" }).click();
    const dialog = screen.getByRole("dialog", { name: /Delete pairing for/ });
    await expect.element(dialog).toBeVisible();
    await expect.element(screen.getByRole("dialog", { name: "Choose computer" })).not.toBeInTheDocument();
    expect(dialog.element().closest(".pwa-root")).not.toBeNull();
    return dialog;
  };
  await expect.element(drawer).toBeVisible();
  let dialog = await requestDelete();
  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("session-confirm-transition")).toHaveAttribute("data-state", "exited");
  await expect.element(drawer).toBeVisible();
  await expect.element(management).toHaveFocus();

  dialog = await requestDelete();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("session-confirm-transition")).toHaveAttribute("data-state", "exited");
  await expect.element(drawer).toBeVisible();
  await expect.element(management).toHaveFocus();

  dialog = await requestDelete();
  await screen.getByRole("button", { name: "Delete pairing" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("session-confirm-transition")).toHaveAttribute("data-state", "exited");
  await expect.element(drawer).toBeVisible();
  // 删除后电脑选择入口的名称随之改变，焦点仍回到同一个入口。
  await expect.poll(() => document.activeElement).toBe(document.querySelector(".pwa-session-sheet .pwa-device-trigger"));
});

test("uses the shared 180/140ms modal motion, blocks pointers while exiting and keeps a single scrim over navigation", async () => {
  const screen = await renderPwa(<SessionConfirmHarness />);
  await expect.element(screen.getByRole("dialog", { name: /Workspace/ })).toBeVisible();
  await screen.getByRole("button", { name: "Choose computer, current office" }).click();
  await screen.getByRole("button", { name: "Computer actions for office" }).click();
  await screen.getByRole("menuitem", { name: "Remove office" }).click();
  const dialog = screen.getByRole("dialog", { name: /Delete pairing for/ });
  await expect.element(dialog).toBeVisible();
  const content = dialog.element() as HTMLElement;
  expect(getComputedStyle(content).transitionDuration).toContain("0.18s");
  await expect.poll(() => getComputedStyle(content).opacity).toBe("1");
  // 只保留最上层遮罩：导航的遮罩在确认弹窗期间隐去，弹窗遮罩使用 scrim token。
  const drawerOverlay = document.querySelector<HTMLElement>(".mantine-Drawer-overlay")!;
  const modalOverlay = document.querySelector<HTMLElement>(".mantine-Modal-overlay")!;
  await expect.poll(() => getComputedStyle(drawerOverlay).opacity).toBe("0");
  expect(modalOverlay.classList.contains("pwa-scrim")).toBe(true);
  expect(getComputedStyle(modalOverlay).backdropFilter).toBe("none");

  await userEvent.keyboard("{Escape}");
  await expect.poll(() => getComputedStyle(content).pointerEvents).toBe("none");
  expect(getComputedStyle(content).transitionDuration).toContain("0.14s");
  await expect.poll(() => document.querySelector(".pwa-confirm-dialog")).toBeNull();
  await expect.poll(() => getComputedStyle(document.querySelector<HTMLElement>(".mantine-Drawer-overlay")!).opacity).not.toBe("0");
});
