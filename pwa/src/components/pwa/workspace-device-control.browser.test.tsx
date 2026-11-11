import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { beforeEach, expect, test } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { WorkspaceDeviceControl, type WorkspaceDeviceControlVariant } from "./workspace-device-control";
import { renderPwa } from "@/test/browser/render";
import type { PwaDeviceRecord } from "@/lib/pwa/db";
import type { DeviceActivity } from "@/lib/pwa/pwa-view-model";
import { minimumControlHeight } from "@/test/browser/button-height";

const currentDevice: PwaDeviceRecord = {
  id: "device:current",
  deviceId: "current-device-public-key",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  nickname: "Current computer with an intentionally very long local name",
};
const nextDevice: PwaDeviceRecord = {
  id: "device:next",
  deviceId: "next-device-public-key",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-02T00:00:00.000Z",
  nickname: "Travel Mac",
};

function DeviceControlHarness({ variant, purpose = "choose", events, devices = [currentDevice, nextDevice] }: { variant: WorkspaceDeviceControlVariant; purpose?: "choose" | "manage"; events: string[]; devices?: PwaDeviceRecord[] }) {
  const [target, setTarget] = useState<string | null>(null);
  const targetRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { targetRef.current?.focus(); }, [target]);
  const finish = (event: string) => { events.push(event); setTarget(event); };
  return <div style={variant === "desktop" ? { width: 286, position: "absolute", left: 12, bottom: 38 } : { width: 286 }}>
    <WorkspaceDeviceControl
      devices={devices}
      activeDeviceId={currentDevice.id}
      pairingPresence={{
        [currentDevice.id]: { status: "online", onlineEndpoints: 2, totalEndpoints: 2 },
        [nextDevice.id]: { status: "offline", onlineEndpoints: 0, totalEndpoints: 1 },
      }}
      onPair={() => finish("pair")}
      onSelectDevice={(deviceId) => finish(`select:${deviceId}`)}
      onRename={(device) => finish(`rename:${device.id}`)}
      onRemove={(device) => finish(`remove:${device.id}`)}
      variant={variant}
      purpose={purpose}
    />
    {target ? <button ref={targetRef} type="button" data-testid="device-action-target">{target}</button> : null}
  </div>;
}

let setDeviceActivity: ((activity: Readonly<Record<string, DeviceActivity>>) => void) | null = null;

function DeviceActivityHarness({ variant, events }: { variant: WorkspaceDeviceControlVariant; events: string[] }) {
  const [activeDeviceId, setActiveDeviceId] = useState(currentDevice.id);
  const [activity, setActivity] = useState<Readonly<Record<string, DeviceActivity>>>({ [currentDevice.id]: "completed" });
  // 只在挂载期间暴露 setter，卸载后不残留指向旧组件的控制入口。
  useEffect(() => {
    setDeviceActivity = setActivity;
    return () => { setDeviceActivity = null; };
  }, []);
  return <div style={variant === "desktop" ? { width: 286, position: "absolute", left: 12, bottom: 38 } : { width: 286 }}>
    <WorkspaceDeviceControl
      devices={[currentDevice, nextDevice]}
      activeDeviceId={activeDeviceId}
      pairingPresence={{
        [currentDevice.id]: { status: "online", onlineEndpoints: 2, totalEndpoints: 2 },
        [nextDevice.id]: { status: "offline", onlineEndpoints: 0, totalEndpoints: 1 },
      }}
      deviceActivity={activity}
      onPair={() => events.push("pair")}
      onSelectDevice={(deviceId) => { events.push(`select:${deviceId}`); setActiveDeviceId(deviceId); }}
      onRename={(device) => events.push(`rename:${device.id}`)}
      onRemove={(device) => events.push(`remove:${device.id}`)}
      variant={variant}
    />
  </div>;
}

beforeEach(async () => { await page.viewport(1280, 800); });

test("desktop chooser uses a portal Popover, truncates long names, and finishes selection without stealing focus", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<DeviceControlHarness variant="desktop" events={events} />);
  const trigger = screen.getByRole("button", { name: /Choose computer, current Current computer/ });
  const triggerNode = trigger.element();
  expect(triggerNode.classList.contains("pwa-device-trigger-compact")).toBe(true);
  expect(triggerNode.querySelector(".pwa-device-trigger-copy small")).toBeNull();
  expect(Math.round(triggerNode.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  const copy = triggerNode.querySelector<HTMLElement>(".pwa-device-trigger-copy strong")!;
  expect(getComputedStyle(copy).whiteSpace).toBe("nowrap");
  expect(getComputedStyle(copy).textOverflow).toBe("ellipsis");
  const triggerBox = triggerNode.getBoundingClientRect();
  const copyBox = copy.getBoundingClientRect();
  expect(Math.abs(Math.round((copyBox.top + copyBox.bottom) / 2) - Math.round((triggerBox.top + triggerBox.bottom) / 2))).toBeLessThanOrEqual(1);
  expect(triggerNode.getAttribute("aria-expanded")).toBe("false");
  const chevron = triggerNode.querySelector<SVGElement>(".pwa-device-trigger-chevron")!;
  await trigger.click();
  await expect.poll(() => triggerNode.getAttribute("aria-expanded")).toBe("true");
  await expect.poll(() => getComputedStyle(chevron).transform).toBe("matrix(-1, 0, 0, -1, 0, 0)");
  const panel = document.querySelector<HTMLElement>(".pwa-device-popover")!;
  expect(panel).not.toBeNull();
  expect(panel.closest(".pwa-root")).not.toBeNull();
  // 与菜单共用同一组进入过渡：原点由实际 data-position 推导，顶部面板从下沿（触发按钮一侧）展开。
  expect(panel.getAttribute("data-position")).toMatch(/^top/);
  expect(Math.round(parseFloat(getComputedStyle(panel).transformOrigin.split(" ")[1]))).toBe(Math.round(panel.offsetHeight));
  expect(parseFloat(getComputedStyle(panel).transitionDuration)).toBe(0.24);
  await expect.poll(() => Math.round(panel.getBoundingClientRect().bottom)).toBeLessThanOrEqual(Math.round(triggerNode.getBoundingClientRect().top));
  expect(Number(getComputedStyle(panel).zIndex)).toBe(220);
  const current = screen.getByRole("button", { name: /Current computer with an intentionally very long local name ONLINE/ });
  const label = current.element().querySelector<HTMLElement>(".pwa-peer-label")!;
  expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
  expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
  expect(current.element().textContent).toContain("Current");
  expect(current.element().textContent).toContain("2 Pis running");
  for (const summary of panel.querySelectorAll<HTMLElement>(".pwa-peer-summary")) {
    expect(summary.scrollWidth, summary.textContent ?? "").toBeLessThanOrEqual(summary.clientWidth);
  }
  await screen.getByRole("button", { name: /Travel Mac OFFLINE/ }).click();
  await expect.poll(() => events).toEqual(["select:device:next"]);
  await expect.element(screen.getByTestId("device-action-target")).toHaveFocus();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await expect.element(screen.getByTestId("device-action-target")).toHaveFocus();
});

test("desktop computer row shows current-computer activity and swaps it live without selecting", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<DeviceActivityHarness variant="desktop" events={events} />);
  try {
    const trigger = screen.getByRole("button", { name: /Choose computer, current Current computer/ });
    await trigger.click();
    const panel = () => document.querySelector<HTMLElement>(".pwa-device-popover");
    await expect.poll(() => panel()).not.toBeNull();
    const enterPanel = panel()!;
    // 等 Popover 进入过渡到达可观察终态后再做几何命中，避免转场中的临时位置。
    await expect.poll(() => Math.round(enterPanel.getBoundingClientRect().bottom)).toBeLessThanOrEqual(Math.round(trigger.element().getBoundingClientRect().top));
    await expect.poll(() => parseFloat(getComputedStyle(enterPanel).opacity)).toBe(1);
    await expect.poll(() => enterPanel.getAnimations().length, { interval: 10, timeout: 2_000 }).toBe(0);
    const computerRow = () => panel()!.querySelector<HTMLElement>(".pwa-computer-select")!;
    const slot = () => computerRow().querySelector<HTMLElement>(".pwa-peer-status-slot")!;
    const more = () => panel()!.querySelector<HTMLElement>(".pwa-peer-menu-trigger")!;
    // 当前电脑也显示完成点，槽固定 16px；更多按钮保持完整命中。
    await expect.poll(() => computerRow().querySelector(".pwa-notice-dot")).not.toBeNull();
    expect(computerRow().querySelector(".pwa-running-indicator")).toBeNull();
    expect(Math.round(slot().getBoundingClientRect().width)).toBe(16);
    const menuBox = more().getBoundingClientRect();
    expect(Math.round(menuBox.width)).toBeGreaterThanOrEqual(44);
    const hit = document.elementFromPoint(Math.round(menuBox.left + menuBox.width / 2), Math.round(menuBox.top + menuBox.height / 2));
    expect(hit === more() || more().contains(hit)).toBe(true);

    flushSync(() => setDeviceActivity?.({ [currentDevice.id]: "running" }));
    await expect.poll(() => computerRow().querySelector(".pwa-running-indicator")).not.toBeNull();
    expect(computerRow().querySelector(".pwa-notice-dot")).toBeNull();
    flushSync(() => setDeviceActivity?.({}));
    await expect.poll(() => computerRow().querySelector(".pwa-running-indicator")).toBeNull();
    expect(slot().textContent).toBe("");

    // 沿真实菜单路径：打开更多菜单后直接 Escape 关闭菜单，再 Escape 关闭浮层，不强制挪动焦点。
    await screen.getByRole("button", { name: "Computer actions for Travel Mac" }).click();
    await expect.element(screen.getByRole("menu")).toBeVisible();
    await userEvent.keyboard("{Escape}{Escape}");
    await expect.poll(() => panel()).toBeNull();
    expect(events).toEqual([]);
  } finally {
    await screen.unmount();
  }
});

test("sheet computer row keeps the status slot and actions reachable in a narrow long-name layout", async () => {
  await page.viewport(320, 568);
  const events: string[] = [];
  const screen = await renderPwa(<DeviceActivityHarness variant="sheet" events={events} />);
  try {
    const trigger = screen.getByRole("button", { name: /Choose computer, current Current computer/ });
    await trigger.click();
    const dialog = screen.getByRole("dialog", { name: "Choose computer" });
    await expect.element(dialog).toBeVisible();
    const row = dialog.element().querySelector<HTMLElement>(".pwa-computer-select")!;
    const label = row.querySelector<HTMLElement>(".pwa-peer-label")!;
    expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    expect(Math.round(label.getBoundingClientRect().right)).toBeLessThanOrEqual(Math.round(row.getBoundingClientRect().right));
    expect(row.querySelector(".pwa-notice-dot")).not.toBeNull();
    expect(Math.round(row.querySelector<HTMLElement>(".pwa-peer-status-slot")!.getBoundingClientRect().width)).toBe(16);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    const more = screen.getByRole("button", { name: "Computer actions for Travel Mac" });
    const menuBox = more.element().getBoundingClientRect();
    expect(Math.round(menuBox.width)).toBeGreaterThanOrEqual(44);
    expect(Math.round(menuBox.height)).toBeGreaterThanOrEqual(44);
    // 状态槽与长名不阻断操作入口：真实点击能打开菜单。
    await more.click();
    await expect.element(screen.getByRole("menu")).toBeVisible();
    await userEvent.keyboard("{Escape}{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
    expect(events).toEqual([]);
  } finally {
    await screen.unmount();
    await page.viewport(1280, 800);
  }
});

test.each(["desktop", "sheet"] as const)("%s computer trigger only reports other-computer completion and preserves it across chooser dismissal", async (variant) => {
  if (variant === "sheet") await page.viewport(320, 568);
  const events: string[] = [];
  const screen = await renderPwa(<DeviceActivityHarness variant={variant} events={events} />);
  try {
    const trigger = screen.getByRole("button", { name: /^Choose computer, current / });
    const triggerNode = trigger.element();
    const dot = () => triggerNode.querySelector<HTMLElement>(".pwa-device-trigger-dot");
    const panel = () => document.querySelector(variant === "desktop" ? ".pwa-device-popover" : ".pwa-device-drawer");
    const copyWidth = () => Math.round(triggerNode.querySelector<HTMLElement>(".pwa-device-trigger-copy")!.getBoundingClientRect().width);
    const originalWidth = copyWidth();
    // 当前电脑完成、其他电脑运行中，以及已不在配对列表中的记录均不触发入口提示。
    expect(dot()).toBeNull();
    expect(triggerNode.getAttribute("aria-describedby")).toBeNull();
    flushSync(() => setDeviceActivity?.({ [currentDevice.id]: "completed", [nextDevice.id]: "running", removed: "completed" }));
    expect(dot()).toBeNull();
    flushSync(() => setDeviceActivity?.({ [currentDevice.id]: "completed", [nextDevice.id]: "completed" }));
    expect(dot()).not.toBeNull();
    const descriptionId = triggerNode.getAttribute("aria-describedby")!;
    expect(document.getElementById(descriptionId)?.textContent).toBe("A run on another computer finished, not yet viewed");
    expect(dot()!.title).toBe("A run on another computer finished, not yet viewed");
    expect(copyWidth()).toBe(originalWidth);
    expect(Math.round(triggerNode.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await page.screenshot({ path: `../../../.vitest/screenshots/other-computer-completion-${variant}.png` });

    triggerNode.focus();
    await trigger.click();
    await expect.poll(panel).not.toBeNull();
    expect(dot()).not.toBeNull();
    // 面板打开期间仍随同一份状态实时更新，不因开关确认任何提醒。
    flushSync(() => setDeviceActivity?.({ [currentDevice.id]: "completed", [nextDevice.id]: "running" }));
    expect(dot()).toBeNull();
    flushSync(() => setDeviceActivity?.({ [currentDevice.id]: "completed", [nextDevice.id]: "completed" }));
    expect(dot()).not.toBeNull();
    if (variant === "desktop") {
      await userEvent.tab();
      expect(document.activeElement?.closest(".pwa-device-popover")).not.toBeNull();
    }
    await userEvent.keyboard("{Escape}");
    await expect.poll(panel).toBeNull();
    await expect.element(trigger).toHaveFocus();
    expect(dot()).not.toBeNull();
    expect(events).toEqual([]);

    // 切换电脑后按新的当前 id 重算，目标电脑仍保留自己的行内提醒。
    flushSync(() => setDeviceActivity?.({ [nextDevice.id]: "completed" }));
    await trigger.click();
    await screen.getByRole("button", { name: /^Travel Mac OFFLINE/ }).click();
    await expect.poll(() => events).toEqual(["select:device:next"]);
    await expect.poll(() => triggerNode.getAttribute("aria-label")).toBe("Choose computer, current Travel Mac");
    expect(dot()).toBeNull();
    expect(triggerNode.getAttribute("aria-describedby")).toBeNull();
    await trigger.click();
    const selectedRow = screen.getByRole("button", { name: /^Travel Mac OFFLINE/ });
    await expect.element(selectedRow).toBeVisible();
    expect(selectedRow.element().querySelector(".pwa-notice-dot")).not.toBeNull();
    if (variant === "desktop") await userEvent.tab();
    await userEvent.keyboard("{Escape}");
    await expect.poll(panel).toBeNull();
    flushSync(() => setDeviceActivity?.({ [currentDevice.id]: "completed", [nextDevice.id]: "completed" }));
    expect(dot()).not.toBeNull();
    flushSync(() => setDeviceActivity?.({}));
    expect(dot()).toBeNull();
  } finally {
    await screen.unmount();
    await page.viewport(1280, 800);
  }
});

test("unpaired desktop footer pairs directly without opening a chooser", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<WorkspaceDeviceControl devices={[]} activeDeviceId={null} pairingPresence={{}} variant="desktop" onPair={() => events.push("pair")} onSelectDevice={() => {}} onRename={() => {}} onRemove={() => {}} />);
  const pair = screen.getByRole("button", { name: "Pair a computer" });
  await expect.element(pair).toBeVisible();
  expect(Math.round(pair.element().getBoundingClientRect().height)).toBeGreaterThanOrEqual(minimumControlHeight(pair.element()));
  await pair.click();
  expect(events).toEqual(["pair"]);
  expect(document.querySelector(".pwa-device-popover")).toBeNull();
});

test("desktop management panel routes rename, remove, and pair after it closes", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<DeviceControlHarness variant="desktop" purpose="manage" events={events} />);
  const trigger = screen.getByRole("button", { name: "Computers" });

  await trigger.click();
  await screen.getByRole("button", { name: "Computer actions for Travel Mac" }).click();
  // 菜单项与其他菜单同规格：最小高 44、左右内边距 12，加面板内边距 4 后文字距面板边缘 16。
  const renameItem = screen.getByRole("menuitem", { name: "Rename Travel Mac" }).element();
  expect(getComputedStyle(renameItem).paddingLeft).toBe("12px");
  // 菜单从触发按钮缩放展开，进入结束后再量命中区。
  await expect.poll(() => Math.round(renameItem.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await screen.getByRole("menuitem", { name: "Rename Travel Mac" }).click();
  await expect.poll(() => events).toEqual(["rename:device:next"]);
  await expect.element(screen.getByTestId("device-action-target")).toHaveFocus();

  await trigger.click();
  await screen.getByRole("button", { name: "Computer actions for Travel Mac" }).click();
  await screen.getByRole("menuitem", { name: "Remove Travel Mac" }).click();
  await expect.poll(() => events.slice(-1)).toEqual(["remove:device:next"]);

  await trigger.click();
  await screen.getByRole("button", { name: "Pair a computer" }).click();
  await expect.poll(() => events.slice(-1)).toEqual(["pair"]);
});

test("reduced motion fades the computer Drawer without movement and returns focus after Escape", async () => {
  await page.viewport(390, 700);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const events: string[] = [];
  const screen = await renderPwa(<DeviceControlHarness variant="sheet" events={events} />);
  try {
    const trigger = screen.getByRole("button", { name: /Choose computer, current Current computer/ });
    trigger.element().focus();
    await trigger.click();
    const dialog = screen.getByRole("dialog", { name: "Choose computer" });
    await expect.element(dialog).toBeVisible();
    const drawer = dialog.element();
    await expect.poll(() => getComputedStyle(drawer).transitionDuration).toBe("0.12s");
    expect(getComputedStyle(drawer).transitionProperty.split(",").map((name) => name.trim())).toContain("opacity");
    // Drawer 的静止态是 translate(0)：计算值为单位矩阵而非 none，只要求没有位移。
    expect(new DOMMatrix(getComputedStyle(drawer).transform).m41).toBe(0);
    const overlay = document.querySelector<HTMLElement>(".mantine-Drawer-overlay")!;
    await expect.poll(() => getComputedStyle(overlay).transitionDuration).toBe("0.12s");
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
    expect(events).toEqual([]);

    await trigger.click();
    await screen.getByRole("button", { name: /Travel Mac OFFLINE/ }).click();
    await expect.poll(() => events).toEqual(["select:device:next"]);
    await expect.element(screen.getByTestId("device-action-target")).toHaveFocus();
  } finally {
    await screen.unmount();
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  }
});

test("mobile chooser is a compact z220 bottom Drawer with reachable actions and stable Escape focus", async () => {
  await page.viewport(320, 568);
  const events: string[] = [];
  const screen = await renderPwa(<DeviceControlHarness variant="sheet" events={events} />);
  const trigger = screen.getByRole("button", { name: /Choose computer, current Current computer/ });
  trigger.element().focus();
  await trigger.click();
  const dialog = screen.getByRole("dialog", { name: "Choose computer" });
  await expect.element(dialog).toBeVisible();
  const root = dialog.element().closest<HTMLElement>(".mantine-Drawer-root")!;
  expect(root.closest(".pwa-root")).not.toBeNull();
  expect(getComputedStyle(root).getPropertyValue("--mb-z-index")).toBe("220");
  await expect.poll(() => Math.round(dialog.element().getBoundingClientRect().bottom)).toBe(window.innerHeight);
  const rect = dialog.element().getBoundingClientRect();
  expect(Math.round(rect.left)).toBeGreaterThanOrEqual(0);
  expect(Math.round(rect.right)).toBeLessThanOrEqual(window.innerWidth);
  expect(Math.round(rect.bottom)).toBeLessThanOrEqual(window.innerHeight);
  expect(rect.height).toBeLessThan(320);
  for (const action of [
    screen.getByRole("button", { name: /Travel Mac OFFLINE/ }),
    screen.getByRole("button", { name: "Computer actions for Travel Mac" }),
    screen.getByRole("button", { name: "Pair a computer" }),
    screen.getByRole("button", { name: "Close computer chooser" }),
  ]) {
    const box = action.element().getBoundingClientRect();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(minimumControlHeight(action.element()));
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await page.screenshot({ path: "../../../.vitest/screenshots/workspace-device-control-320x568.png" });
  await screen.getByRole("button", { name: "Computer actions for Travel Mac" }).click();
  await expect.element(screen.getByRole("menu")).toBeVisible();
  await userEvent.keyboard("{Escape}{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
  expect(events).toEqual([]);
});

test("desktop trigger toggles, closes on outside click or Escape, and preserves other focus", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<DeviceControlHarness variant="desktop" events={events} />);
  const trigger = screen.getByRole("button", { name: /Choose computer, current Current computer/ });
  const panel = () => document.querySelector<HTMLElement>(".pwa-device-popover");
  await trigger.click();
  await expect.poll(() => trigger.element().getAttribute("aria-expanded")).toBe("true");
  await expect.poll(() => panel()).not.toBeNull();
  // 重复点击关闭，箭头与 aria-expanded 同步。
  await trigger.click();
  await expect.poll(() => trigger.element().getAttribute("aria-expanded")).toBe("false");
  await expect.poll(() => panel()).toBeNull();
  // 快速反向后再次开关，状态始终与真实浮层一致。
  await trigger.click();
  await expect.poll(() => panel()).not.toBeNull();
  await trigger.click();
  await expect.poll(() => panel()).toBeNull();
  // 外部点击关闭，不把焦点从用户刚点的控件夺走。
  await trigger.click();
  await expect.poll(() => panel()).not.toBeNull();
  const outside = document.createElement("button");
  outside.type = "button";
  outside.textContent = "Outside";
  document.body.append(outside);
  try {
    await userEvent.click(outside);
    await expect.poll(() => panel()).toBeNull();
    expect(document.activeElement).toBe(outside);
  } finally {
    outside.remove();
  }
  // Escape 从面板内真实可聚焦项关闭并回到入口。
  await trigger.click();
  await expect.poll(() => panel()).not.toBeNull();
  (screen.getByRole("button", { name: /Travel Mac OFFLINE/ }).element() as HTMLButtonElement).focus();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => panel()).toBeNull();
  await expect.element(trigger).toHaveFocus();
  expect(events).toEqual([]);
});

test("reopening during the popover exit transition keeps the panel open", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<DeviceControlHarness variant="desktop" events={events} />);
  const trigger = screen.getByRole("button", { name: /Choose computer, current Current computer/ });
  const triggerNode = trigger.element() as HTMLButtonElement;
  const findPanel = () => document.querySelector<HTMLElement>(".pwa-device-popover");
  // 先等进入转场真正结束，避免随后把进入的 transitionrun 当成退场门槛。
  let enterEnded = false;
  const onEnterTransitionEnd = (event: TransitionEvent) => {
    if (event.target === findPanel() && event.propertyName === "opacity") enterEnded = true;
  };
  document.addEventListener("transitionend", onEnterTransitionEnd, true);
  await trigger.click();
  await expect.poll(() => triggerNode.getAttribute("aria-expanded")).toBe("true");
  await expect.poll(() => enterEnded, { interval: 10, timeout: 2_000 }).toBe(true);
  document.removeEventListener("transitionend", onEnterTransitionEnd, true);

  const panelNode = findPanel()!;
  let exitSnapshot: { expanded: string | null; connected: boolean } | null = null;
  const onExitTransitionRun = (event: TransitionEvent) => {
    if (event.target !== panelNode || event.propertyName !== "opacity" || exitSnapshot) return;
    exitSnapshot = { expanded: triggerNode.getAttribute("aria-expanded"), connected: panelNode.isConnected };
  };
  panelNode.addEventListener("transitionrun", onExitTransitionRun);
  flushSync(() => triggerNode.click());
  expect(triggerNode.getAttribute("aria-expanded")).toBe("false");
  await expect.poll(() => exitSnapshot, { interval: 10, timeout: 2_000 }).not.toBeNull();
  expect(exitSnapshot).toEqual({ expanded: "false", connected: true });
  // 退场透明度实际开始下降时才重开：此时退场仍在进行，节点尚未卸载。
  // 门槛在同一次同步回调内闭合，避免“检查通过、点击前退场已结束”的空窗：
  // 透明度必须严格介于 0 与 1 之间（0 说明退场已走完）、面板仍是当前连接节点，
  // 且确实存在 running 的 opacity CSS 转场。
  let reversed = false;
  await expect
    .poll(
      () => {
        if (reversed) return true;
        const opacity = parseFloat(getComputedStyle(panelNode).opacity);
        const opacityTransitionRunning = panelNode
          .getAnimations()
          .some(
            (animation) =>
              animation instanceof CSSTransition &&
              animation.transitionProperty === "opacity" &&
              animation.playState === "running",
          );
        if (!(opacity > 0 && opacity < 1 && opacityTransitionRunning && findPanel() === panelNode && panelNode.isConnected)) {
          return false;
        }
        reversed = true;
        flushSync(() => triggerNode.click());
        return true;
      },
      { interval: 10, timeout: 2_000 },
    )
    .toBe(true);
  await expect.poll(() => triggerNode.getAttribute("aria-expanded")).toBe("true");
  // 重开必须真的启动入场转场，而不是退场被中断后直接静止。
  await expect.poll(() => findPanel()!.getAnimations().length, { interval: 10, timeout: 2_000 }).toBeGreaterThan(0);
  await expect.poll(() => parseFloat(getComputedStyle(findPanel()!).opacity)).toBe(1);
  // 所有入场转场结束；旧退场若在结束阶段关闭面板，这里会看到 aria-expanded=false。
  await expect.poll(() => findPanel()!.getAnimations().length, { interval: 10, timeout: 2_000 }).toBe(0);
  expect(triggerNode.getAttribute("aria-expanded")).toBe("true");
  const row = screen.getByRole("button", { name: /Travel Mac OFFLINE/ }).element();
  const rowBox = row.getBoundingClientRect();
  const hit = document.elementFromPoint(Math.round(rowBox.left + rowBox.width / 2), Math.round(rowBox.top + rowBox.height / 2));
  expect(hit === row || row.contains(hit)).toBe(true);
  // 正常关闭后无排队动作残留，也不残留旧面板。
  flushSync(() => triggerNode.click());
  await expect.poll(() => triggerNode.getAttribute("aria-expanded")).toBe("false");
  await expect.poll(() => findPanel()).toBeNull();
  expect(events).toEqual([]);
});

test("queued action keeps the panel closed when the trigger is pressed again", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<DeviceControlHarness variant="desktop" events={events} />);
  const trigger = screen.getByRole("button", { name: /Choose computer, current Current computer/ });
  await trigger.click();
  await expect.poll(() => document.querySelector(".pwa-device-popover")).not.toBeNull();
  const row = screen.getByRole("button", { name: /Travel Mac OFFLINE/ }).element() as HTMLButtonElement;
  flushSync(() => row.click());
  // 退出动画尚未结束、动作已排队：不能再打开面板，否则动作会被搁置。
  flushSync(() => (trigger.element() as HTMLButtonElement).click());
  await expect.poll(() => document.querySelector(".pwa-device-popover")).toBeNull();
  await expect.poll(() => events).toEqual(["select:device:next"]);
  await expect.element(screen.getByTestId("device-action-target")).toHaveFocus();
});

test("computer trigger stays a single line for one and many computers", async () => {
  for (const devices of [[currentDevice], [currentDevice, nextDevice]]) {
    const screen = await renderPwa(<DeviceControlHarness variant="desktop" events={[]} devices={devices} />);
    const trigger = document.querySelector<HTMLElement>(".pwa-device-trigger")!;
    expect(trigger.classList.contains("pwa-device-trigger-compact")).toBe(true);
    expect(trigger.querySelector(".pwa-device-trigger-dot")).toBeNull();
    expect(trigger.querySelector(".pwa-peer-icon")).toBeNull();
    expect(trigger.querySelector(".pwa-device-trigger-copy small")).toBeNull();
    expect(trigger.querySelector(".pwa-device-trigger-chevron")).not.toBeNull();
    expect(Math.round(trigger.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await screen.unmount();
  }
});

test("unpaired mobile footer pairs directly without opening an empty chooser", async () => {
  await page.viewport(320, 568);
  const events: string[] = [];
  const screen = await renderPwa(<WorkspaceDeviceControl devices={[]} activeDeviceId={null} pairingPresence={{}} variant="sheet" onPair={() => events.push("pair")} onSelectDevice={() => {}} onRename={() => {}} onRemove={() => {}} />);
  const pair = screen.getByRole("button", { name: "Pair a computer" });
  await pair.click();
  expect(events).toEqual(["pair"]);
  expect(document.querySelector(".pwa-device-drawer")).toBeNull();
});
