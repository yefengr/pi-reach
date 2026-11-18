import { afterEach, beforeEach, expect, test } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaWorkspaceLayout } from "./pwa-workspace-layout";
import type { WorkspaceNavigationProps } from "./workspace-view";
import { useSettingsRoute } from "@/lib/pwa/settings-route";
import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";
import { enableTouch, pointer, resetTouch, touch, touchOrigin, touchReleaseAtRest, touchTap } from "@/test/browser/swipe";

/**
 * 移动导航入口的焦点圈回归：普通触屏关闭侧栏后，真实 DOM 焦点仍回到入口，
 * 但入口不残留 :focus-visible 圆圈；键盘、虚拟激活和未知输入方式保持原生可见焦点。
 */
const baseNavigation: WorkspaceNavigationProps = {
  devices: [], endpoints: [], history: [], activeDeviceId: null, activeEndpointId: null, selectedHistoryId: null, snapshotReady: true, pairingPresence: {},
  onPair: () => {}, onSettings: () => {}, onSelectDevice: () => {}, onSelectEndpoint: () => {}, onSelectHistory: () => {}, onRename: () => {}, onRemove: () => {},
};

const focusDevice: PwaDeviceRecord = {
  id: "device:focus", deviceId: "focus-device", relayUrl: "https://relay.example.test", pairedAt: "2026-01-01T00:00:00.000Z", nickname: "Focus computer",
};
const focusEndpoints: PwaEndpointRecord[] = [
  { id: "endpoint:current", deviceId: focusDevice.deviceId, endpointId: "current", runtimeInstanceId: "current-runtime", kind: "interactive", name: "Current Pi", online: true, updatedAt: 1 },
  { id: "endpoint:other", deviceId: focusDevice.deviceId, endpointId: "other", runtimeInstanceId: "other-runtime", kind: "interactive", name: "Other Pi", online: true, updatedAt: 2 },
];

type HarnessProps = { navigation?: Partial<WorkspaceNavigationProps> };

function Harness({ navigation: overrides }: HarnessProps = {}) {
  const { route, openSettings, closeSettings } = useSettingsRoute();
  const navigation = { ...baseNavigation, ...overrides };
  return <PwaUiProvider><PwaAppShell runtimeNotice={null}><PwaWorkspaceLayout
    navigation={navigation}
    titleBar={{ title: "Focus Pi", showTitle: true }}
    toast={null}
    settingsRoute={route}
    onOpenSettings={openSettings}
    onSettingsBack={closeSettings}
    renderSettings={({ titleRef }) => <><h1 ref={titleRef} tabIndex={-1}>Settings</h1><button type="button" onClick={closeSettings}>Back</button></>}
    overlays={null}
    closeBackgroundOverlay={(close) => { close(); }}
  >
    <div className="pwa-message-list"><p>Body copy</p></div>
    <div className="pwa-composer"><input aria-label="Draft" /></div>
  </PwaWorkspaceLayout></PwaAppShell></PwaUiProvider>;
}

async function setup(props: HarnessProps = {}) {
  const screen = await render(<Harness {...props} />);
  const trigger = document.querySelector<HTMLButtonElement>(".pwa-session-trigger");
  if (!trigger) throw new Error("missing navigation trigger");
  await expect.element(screen.getByRole("button", { name: "Open navigation" })).toBeVisible();
  const icon = trigger.querySelector<HTMLElement>(".pwa-session-trigger-icon")!;
  return { screen, trigger, icon };
}

async function focusTriggerByKeyboard(trigger: HTMLButtonElement) {
  (document.activeElement as HTMLElement | null)?.blur();
  for (let step = 0; step < 8 && document.activeElement !== trigger; step += 1) await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(trigger);
}

async function openByTouch(screen: Awaited<ReturnType<typeof setup>>["screen"], trigger: HTMLButtonElement) {
  await touchTap(touchOrigin(trigger));
  await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
  await expect.element(screen.getByRole("dialog", { name: /Workspace/ })).toBeVisible();
  // 等进入动画落位后再取抽屉边缘，遮罩的可点区域才不会随位移动画变化。
  await expect.poll(() => Math.round(document.querySelector(".pwa-session-sheet")!.getBoundingClientRect().left)).toBe(0);
  // 焦点先交给抽屉，之后关闭才由 SessionSheet 交回入口。
  await expect.poll(() => Boolean(document.querySelector(".pwa-session-sheet")?.contains(document.activeElement))).toBe(true);
}

/** 点按遮罩关闭：遮罩在抽屉右侧仍有可点区域，CDP 触摸点击带 detail 计数，与真实触屏一致。 */
async function closeByTouch(trigger: HTMLButtonElement) {
  const sheet = document.querySelector<HTMLElement>(".pwa-session-sheet")!;
  const x = Math.min(window.innerWidth - 5, Math.round(sheet.getBoundingClientRect().right) + 16);
  await touchTap({ x, y: 400, id: 1 });
  await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
  await expect.poll(() => document.querySelector(".pwa-session-sheet") === null).toBe(true);
  await expect.poll(() => document.activeElement === trigger).toBe(true);
}

beforeEach(async () => {
  window.history.replaceState(null, "", "/app");
  await page.viewport(390, 844);
  await enableTouch();
});

afterEach(async () => {
  await resetTouch();
  window.history.replaceState(null, "", "/app");
  await page.viewport(1280, 900);
});

test("suppresses the entry ring only while the last known input is an ordinary touch", async () => {
  const { trigger, icon } = await setup();
  await focusTriggerByKeyboard(trigger);
  expect(trigger.matches(":focus-visible")).toBe(true);
  expect(getComputedStyle(icon).outlineStyle).toBe("solid");

  // Chromium 的触摸判定不会复现设备上程序化回焦继承 :focus-visible 的差异，
  // 因此在真实键盘焦点上叠加触摸输入标记，验证局部抑制规则本身；标记由真实事件写入。
  pointer(trigger, "pointerdown", 40, 24, { pointerType: "touch" });
  pointer(trigger, "pointerup", 40, 24, { pointerType: "touch" });
  expect(document.activeElement).toBe(trigger);
  expect(trigger.matches(":focus-visible")).toBe(true);
  expect(getComputedStyle(icon).outlineStyle).toBe("none");

  // 鼠标按下清除标记，原生规则恢复：不是触摸关闭就一直隐藏圆圈。
  pointer(trigger, "pointerdown", 40, 24, { pointerType: "mouse", pointerId: 2 });
  await expect.poll(() => getComputedStyle(icon).outlineStyle).toBe("solid");
  expect(trigger.hasAttribute("data-navigation-touch")).toBe(false);
});

test("returns DOM focus after a touch close without leaving the entry ring", async () => {
  const { screen, trigger, icon } = await setup();
  await openByTouch(screen, trigger);
  await closeByTouch(trigger);
  // 真实回焦仍落在入口；只隐藏圆圈，不改变焦点交接。
  expect(document.activeElement).toBe(trigger);
  expect(trigger.hasAttribute("data-navigation-touch")).toBe(true);
  expect(getComputedStyle(icon).outlineStyle).toBe("none");
  expect(Math.round(trigger.getBoundingClientRect().height)).toBe(44);
  await page.screenshot({ path: "../../../../.pi/tmp/navigation-focus/touch.png" });
});

test("keeps the entry ring when a keyboard closes the drawer after a touch open", async () => {
  const { screen, trigger, icon } = await setup();
  await openByTouch(screen, trigger);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
  await expect.poll(() => document.querySelector(".pwa-session-sheet") === null).toBe(true);
  await expect.poll(() => document.activeElement === trigger).toBe(true);
  expect(trigger.hasAttribute("data-navigation-touch")).toBe(false);
  expect(trigger.matches(":focus-visible")).toBe(true);
  expect(getComputedStyle(icon).outlineStyle).toBe("solid");
  expect(getComputedStyle(icon).outlineWidth).toBe("2px");
  await page.screenshot({ path: "../../../../.pi/tmp/navigation-focus/keyboard.png" });
});

test("restores the native ring after a virtual click without a pointer count", async () => {
  const { screen, trigger, icon } = await setup();
  await openByTouch(screen, trigger);
  await closeByTouch(trigger);
  expect(trigger.hasAttribute("data-navigation-touch")).toBe(true);
  // 读屏等虚拟激活的 click 没有 detail 计数，按键盘处理并清掉触摸标记。
  trigger.click();
  await expect.poll(() => trigger.hasAttribute("data-navigation-touch")).toBe(false);
  await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
  await expect.poll(() => document.querySelector(".pwa-session-sheet") === null).toBe(true);
  await expect.poll(() => document.activeElement === trigger).toBe(true);
  expect(getComputedStyle(icon).outlineStyle).toBe("solid");
});

test("does not leave a stale touch marker across repeated touch open and close cycles", async () => {
  const { screen, trigger, icon } = await setup();
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await openByTouch(screen, trigger);
    await closeByTouch(trigger);
    expect(document.activeElement).toBe(trigger);
    expect(getComputedStyle(icon).outlineStyle).toBe("none");
    expect(trigger.hasAttribute("data-navigation-touch")).toBe(true);
  }
  // 之后键盘接管：标记清除，不残留抑制状态。
  await userEvent.keyboard("{Tab}");
  expect(trigger.hasAttribute("data-navigation-touch")).toBe(false);
});

test("keeps composer focus when the touch lands outside the navigation entry", async () => {
  const { trigger, icon } = await setup();
  const draft = document.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!;
  await touchTap(touchOrigin(draft));
  await expect.poll(() => document.activeElement).toBe(draft);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(getComputedStyle(icon).outlineStyle).toBe("none");
});

test("returns focus after the drawer close control is touched", async () => {
  const { screen, trigger, icon } = await setup();
  await openByTouch(screen, trigger);
  const close = document.querySelector<HTMLButtonElement>(".pwa-navigation-close");
  if (!close) throw new Error("missing navigation close control");
  await touchTap(touchOrigin(close));
  await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
  await expect.poll(() => document.querySelector(".pwa-session-sheet") === null).toBe(true);
  await expect.poll(() => document.activeElement === trigger).toBe(true);
  expect(getComputedStyle(icon).outlineStyle).toBe("none");
});

/** 分步推进真实渲染时间，让滑动的速度采样看到与设备接近的间隔。 */
async function advanceFrames(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) await new Promise((resolve) => requestAnimationFrame(resolve));
}

test("closes the drawer when a left swipe crosses half of the sheet", async () => {
  const { screen, trigger, icon } = await setup();
  await openByTouch(screen, trigger);
  const sheet = document.querySelector<HTMLElement>(".pwa-session-sheet")!;
  // 320px 宽的抽屉行程过半即提交；停稳后松手，结果不受机器快慢影响。
  const origin = touchOrigin(sheet, 250, 160);
  await touch("touchStart", [origin]);
  for (let step = 1; step <= 8; step += 1) {
    await advanceFrames(25);
    await touch("touchMove", [{ ...origin, x: origin.x - 30 * step }]);
  }
  await touchReleaseAtRest();
  await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
  await expect.poll(() => document.querySelector(".pwa-session-sheet") === null).toBe(true);
  await expect.poll(() => document.activeElement === trigger).toBe(true);
  expect(getComputedStyle(icon).outlineStyle).toBe("none");
});

test("selects another endpoint from the drawer and restores entry focus", async () => {
  const events: string[] = [];
  const { screen, trigger, icon } = await setup({
    navigation: {
      devices: [focusDevice],
      endpoints: focusEndpoints,
      activeDeviceId: focusDevice.id,
      activeEndpointId: "current",
      onSelectEndpoint: (endpointId) => events.push(endpointId),
    },
  });
  await openByTouch(screen, trigger);
  const other = [...document.querySelectorAll<HTMLButtonElement>(".pwa-session-sheet button")]
    .find((button) => button.textContent?.includes("Other Pi"));
  if (!other) throw new Error("missing other endpoint");
  await touchTap(touchOrigin(other));
  await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
  await expect.poll(() => events).toEqual(["other"]);
  await expect.poll(() => document.querySelector(".pwa-session-sheet") === null).toBe(true);
  await expect.poll(() => document.activeElement === trigger).toBe(true);
  expect(getComputedStyle(icon).outlineStyle).toBe("none");
});

test("keeps the native entry ring in forced colors mode", async () => {
  const { trigger, icon } = await setup();
  await focusTriggerByKeyboard(trigger);
  expect(trigger.matches(":focus-visible")).toBe(true);
  pointer(trigger, "pointerdown", 40, 24, { pointerType: "touch" });
  pointer(trigger, "pointerup", 40, 24, { pointerType: "touch" });
  expect(trigger.hasAttribute("data-navigation-touch")).toBe(true);
  try {
    await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    await expect.poll(() => getComputedStyle(icon).outlineStyle).toBe("solid");
    expect(getComputedStyle(icon).outlineWidth).toBe("2px");
  } finally {
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  }
});

test("keeps focus moved outside the drawer while it exits", async () => {
  const { screen, trigger } = await setup();
  await openByTouch(screen, trigger);
  const draft = document.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!;
  const close = document.querySelector<HTMLButtonElement>(".pwa-navigation-close");
  if (!close) throw new Error("missing navigation close control");
  pointer(close, "pointerdown", 16, 16, { pointerType: "touch" });
  pointer(close, "pointerup", 16, 16, { pointerType: "touch" });
  close.click();
  await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
  // 退出动画期间用户已把焦点移出抽屉，收尾回焦不得抢回入口。
  draft.focus({ preventScroll: true });
  await expect.poll(() => document.querySelector(".pwa-session-sheet") === null).toBe(true);
  await expect.poll(() => document.activeElement === draft).toBe(true);
});
