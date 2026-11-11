import { afterEach, expect, test } from "vitest";
import { cdp } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaOperationNotifications } from "./pwa-operation-notifications";
import { pointerAt } from "@/test/browser/swipe";
import { createOperationNotificationController, type OperationNotificationController } from "@/lib/pwa/operation-notifications";

function Harness({ controller }: { controller: OperationNotificationController }) {
  return <PwaUiProvider><div className="pwa-root">
    <div className="pwa-layout"><main className="pwa-main">
      <header className="pwa-title-bar" />
      <PwaOperationNotifications controller={controller} />
    </main></div>
  </div></PwaUiProvider>;
}

const card = () => document.querySelector<HTMLElement>(".pwa-operation-notification");
const cardTop = () => Math.round(card()!.getBoundingClientRect().top);
const shown = (controller: OperationNotificationController) => controller.store.getState().notifications.length;
const setReducedMotion = (reduce: boolean) => cdp().send("Emulation.setEmulatedMedia", { features: reduce ? [{ name: "prefers-reduced-motion", value: "reduce" }] : [] });

async function mount(show: (controller: OperationNotificationController) => void = (controller) => controller.show("thinking_set-error")) {
  const controller = createOperationNotificationController();
  const screen = await render(<Harness controller={controller} />);
  show(controller);
  await expect.poll(() => card()?.getAnimations().length).toBe(0);
  await expect.poll(() => getComputedStyle(card()!).opacity).toBe("1");
  const rect = card()!.getBoundingClientRect();
  return { controller, screen, rest: Math.round(rect.top), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, extent: rect.bottom };
}

afterEach(async () => { await setReducedMotion(false); });

test("the toast follows an upward drag and returns when released at rest short of half way off screen", async () => {
  const { controller, rest, x, y } = await mount();
  pointerAt(card()!, "pointerdown", x, y, 0);
  pointerAt(card()!, "pointermove", x, y - 14, 50);
  pointerAt(card()!, "pointermove", x, y - 34, 100);
  // 位移 = 手指位移 − 方向锁定那一帧的位移。
  expect(cardTop()).toBe(rest - 20);
  pointerAt(card()!, "pointerup", x, y - 34, 400);
  await expect.poll(() => card()!.getAnimations().length).toBe(0);
  expect(cardTop()).toBe(rest);
  expect(card()!.style.translate).toBe("");
  expect(shown(controller)).toBe(1);
});

test("releasing at rest past half way dismisses through the close path and the next toast starts in place", async () => {
  const dismissals: string[] = [];
  const { controller, rest, x, y, extent } = await mount((controller) => controller.showUpdate("Update ready", { label: "Refresh", onClick: () => {} }, () => dismissals.push("update")));
  const lift = Math.ceil(extent / 2) + 20;
  pointerAt(card()!, "pointerdown", x, y, 0);
  pointerAt(card()!, "pointermove", x, y - 14, 50);
  pointerAt(card()!, "pointermove", x, y - lift, 200);
  pointerAt(card()!, "pointerup", x, y - lift, 500);
  expect(shown(controller)).toBe(0);
  // 与关闭按钮同一入口：更新提示的关闭回调照常触发。
  expect(dismissals).toEqual(["update"]);
  controller.show("thinking_set-error");
  await expect.poll(() => shown(controller)).toBe(1);
  await expect.poll(() => card() && getComputedStyle(card()!).opacity).toBe("1");
  await expect.poll(() => card()!.getAnimations().length).toBe(0);
  expect(card()!.style.translate).toBe("");
  expect(cardTop()).toBe(rest);
});

test("a short quick upward flick dismisses by its projected stop", async () => {
  const { controller, x, y } = await mount();
  pointerAt(card()!, "pointerdown", x, y, 0);
  pointerAt(card()!, "pointermove", x, y - 14, 20);
  pointerAt(card()!, "pointerup", x, y - 40, 72);
  expect(shown(controller)).toBe(0);
});

test.each([["downward", 0, 60], ["sideways", 80, -10]] as const)("a %s drag neither moves nor dismisses the toast", async (_name, dx, dy) => {
  const { controller, rest, x, y } = await mount();
  pointerAt(card()!, "pointerdown", x, y, 0);
  pointerAt(card()!, "pointermove", x + dx / 2, y + dy / 2, 50);
  pointerAt(card()!, "pointermove", x + dx, y + dy, 100);
  expect(cardTop()).toBe(rest);
  pointerAt(card()!, "pointerup", x + dx, y + dy, 130);
  expect(shown(controller)).toBe(1);
  expect(card()!.style.translate).toBe("");
});

test("mouse drags are ignored", async () => {
  const { controller, rest, x, y } = await mount();
  pointerAt(card()!, "pointerdown", x, y, 0, { pointerType: "mouse" });
  pointerAt(card()!, "pointermove", x, y - 80, 50, { pointerType: "mouse" });
  expect(cardTop()).toBe(rest);
  pointerAt(card()!, "pointerup", x, y - 80, 80, { pointerType: "mouse" });
  expect(shown(controller)).toBe(1);
});

test("a cancelled touch returns the toast and keeps it", async () => {
  const { controller, rest, x, y } = await mount();
  pointerAt(card()!, "pointerdown", x, y, 0);
  pointerAt(card()!, "pointermove", x, y - 14, 50);
  pointerAt(card()!, "pointermove", x, y - 60, 100);
  pointerAt(card()!, "pointercancel", x, y - 60, 120);
  await expect.poll(() => card()!.getAnimations().length).toBe(0);
  expect(cardTop()).toBe(rest);
  expect(shown(controller)).toBe(1);
});

test("reduced motion does not follow the finger but still dismisses on release", async () => {
  await setReducedMotion(true);
  const { controller, rest, x, y, extent } = await mount();
  const lift = Math.ceil(extent / 2) + 20;
  pointerAt(card()!, "pointerdown", x, y, 0);
  pointerAt(card()!, "pointermove", x, y - 14, 50);
  pointerAt(card()!, "pointermove", x, y - lift, 200);
  expect(cardTop()).toBe(rest);
  expect(card()!.style.translate).toBe("");
  pointerAt(card()!, "pointerup", x, y - lift, 500);
  expect(shown(controller)).toBe(0);
});
