import { createRef, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronRight } from "lucide-react";
import { afterEach, expect, test } from "vitest";
import { cdp, page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { MessageList } from "./message-list";
import { RunningIndicator } from "./running-indicator";
import { OnlinePiRow } from "./workspace-view";
import type { PwaEndpointRecord } from "@/lib/pwa/db";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";

type RowState = { working: boolean; current: boolean; completed: boolean };
const sessionName = "A session with a deliberately long name for ellipsis";

function endpoint(cwd: string | null = "/workspace/pi-reach"): PwaEndpointRecord {
  return { id: "endpoint-alpha", deviceId: "e5FRoCabBqVX", endpointId: "alpha", runtimeInstanceId: "runtime-alpha", kind: "interactive", name: sessionName, cwd: cwd ?? undefined, online: true, updatedAt: 1 };
}

let setRowState: ((next: RowState) => void) | null = null;
function RowHarness({ initial, cwd, trailing = false }: { initial: RowState; cwd?: string | null; trailing?: boolean }) {
  const [state, update] = useState(initial);
  // 只通过 effect 暴露 setter，卸载时释放，避免渲染期赋值或卸载后仍被调用。
  useEffect(() => {
    setRowState = update;
    return () => { setRowState = null; };
  }, [update]);
  return <div className="pwa-sidebar" style={{ width: 280, padding: 8 }}>
    <OnlinePiRow endpoint={{ ...endpoint(cwd), working: state.working }} current={state.current} completed={state.completed} onSelect={() => {}} trailing={trailing ? <ChevronRight size={20} data-testid="row-chevron" /> : undefined} />
  </div>;
}
function updateRow(next: RowState) { flushSync(() => setRowState!(next)); }
function rect(selector: string): DOMRect {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  return element!.getBoundingClientRect();
}
const rounded = (value: number) => Math.round(value);
const center = (element: DOMRect) => rounded(element.top + element.height / 2);
const geometry = () => {
  const title = rect(".pwa-pi-title");
  const directory = rect(".pwa-pi-directory");
  return { title: [rounded(title.left), rounded(title.width), rounded(title.top)], directory: [rounded(directory.left), rounded(directory.width), rounded(directory.top)] };
};

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  delete document.documentElement.dataset.pwaTextSize;
  await page.viewport(1280, 900);
});

test.each([1280, 390])("status changes never move the row text at %ipx", async width => {
  await page.viewport(width, 844);
  const screen = await renderPwa(<RowHarness initial={{ working: false, current: false, completed: false }} />);
  const baseline = geometry();
  updateRow({ working: true, current: false, completed: true });
  expect(geometry()).toEqual(baseline);
  updateRow({ working: true, current: true, completed: true });
  expect(geometry()).toEqual(baseline);
  updateRow({ working: false, current: false, completed: true });
  expect(geometry()).toEqual(baseline);
  updateRow({ working: false, current: false, completed: false });
  expect(geometry()).toEqual(baseline);
  await screen.unmount();
});

test.each(["standard", "large", "xlarge"] as const)("centers the status and action chevron on the whole row at %s text size", async size => {
  document.documentElement.dataset.pwaTextSize = size;
  const screen = await renderPwa(<RowHarness initial={{ working: true, current: true, completed: false }} trailing />);
  const row = rect(".pwa-nav-session");
  const indicator = rect(".pwa-running-indicator");
  const dot = rect(".pwa-running-indicator-dot");
  expect([rounded(indicator.width), rounded(indicator.height)]).toEqual([16, 16]);
  expect([rounded(dot.width), rounded(dot.height)]).toEqual([6, 6]);
  expect(center(dot)).toBe(center(row));
  expect(center(rect('[data-testid="row-chevron"]'))).toBe(center(row));
  updateRow({ working: false, current: false, completed: true });
  expect(center(rect(".pwa-notice-dot"))).toBe(center(row));
  await screen.unmount();
});

test("shows one accessible status mark per row and restores the completed hint", async () => {
  const screen = await renderPwa(<RowHarness initial={{ working: false, current: false, completed: false }} />);
  const slot = () => document.querySelector<HTMLElement>(".pwa-pi-status-slot")!;
  expect(document.querySelector(".pwa-pi-title")?.textContent).toBe(sessionName);
  expect(document.querySelector(".pwa-pi-directory")?.textContent).toBe("pi-reach");
  expect(document.body.textContent).not.toContain("Idle");
  expect(slot().childElementCount).toBe(0);

  updateRow({ working: true, current: false, completed: true });
  expect(slot().querySelectorAll(":scope > *")).toHaveLength(1);
  expect(slot().querySelector('[aria-label="Running"]')).not.toBeNull();
  expect(slot().querySelector(".pwa-notice-dot")).toBeNull();

  updateRow({ working: false, current: false, completed: true });
  expect(slot().querySelectorAll(":scope > *")).toHaveLength(1);
  const completed = slot().querySelector<HTMLElement>(".pwa-notice-dot")!;
  expect(completed.getAttribute("aria-label")).toBe("Run finished, not yet viewed");
  expect(completed.getAttribute("title")).toBe("Run finished, not yet viewed");
  expect([rounded(completed.getBoundingClientRect().width), rounded(completed.getBoundingClientRect().height)]).toEqual([6, 6]);

  updateRow({ working: false, current: true, completed: true });
  expect(slot().childElementCount).toBe(0);
  await screen.unmount();
});

test("omits the directory line and keeps the running dot centered when cwd is missing", async () => {
  const screen = await renderPwa(<RowHarness initial={{ working: true, current: false, completed: false }} cwd={null} />);
  expect(document.querySelector(".pwa-pi-title")?.textContent).toBe(sessionName);
  expect(document.querySelector(".pwa-pi-directory")).toBeNull();
  expect(center(rect(".pwa-running-indicator-dot"))).toBe(center(rect(".pwa-nav-session")));
  await screen.unmount();
});

test("reduced motion keeps the static running dot filled and unanimated", async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const screen = await renderPwa(<RowHarness initial={{ working: true, current: false, completed: true }} />);
  const dot = document.querySelector<HTMLElement>(".pwa-running-indicator-dot")!;
  const style = getComputedStyle(dot);
  expect(style.opacity).toBe("1");
  expect(style.borderTopWidth).toBe("0px");
  expect(style.animationName).toBe("none");
  expect(dot.getAnimations()).toHaveLength(0);
  expect(dot.hasAttribute("data-pwa-animation")).toBe(false);
  updateRow({ working: false, current: false, completed: true });
  const completed = document.querySelector<HTMLElement>(".pwa-notice-dot")!;
  expect(getComputedStyle(completed).backgroundColor).not.toBe(style.backgroundColor);
  await screen.unmount();
});

test("running dot stays a static filled point in both sizes without motion", async () => {
  const screen = await renderPwa(<div style={{ padding: 20 }}><RunningIndicator size="compact" /><RunningIndicator /></div>);
  const dots = [...document.querySelectorAll<HTMLElement>(".pwa-running-indicator-dot")];
  expect([rounded(dots[0]!.getBoundingClientRect().width), rounded(dots[1]!.getBoundingClientRect().width)]).toEqual([6, 8]);
  const theme = getComputedStyle(document.documentElement);
  // 运行点不再有独立呼吸幅度：骨架屏的 0.72 保持不变，运行点始终满亮。
  expect(theme.getPropertyValue("--pwa-opacity-running-breathe").trim()).toBe("");
  expect(theme.getPropertyValue("--pwa-opacity-breathe").trim()).toBe("0.72");
  for (const dot of dots) {
    const style = getComputedStyle(dot);
    expect(style.opacity).toBe("1");
    expect(style.animationName).toBe("none");
    expect(style.transform).toBe("none");
    expect(style.backgroundColor).toBe(getComputedStyle(dot.parentElement!).color);
    expect(dot.getAnimations()).toHaveLength(0);
    expect(dot.hasAttribute("data-pwa-animation")).toBe(false);
  }
  await screen.unmount();
});

const userEvent: TimelineEvent = {
  event_id: "user", message_id: "user", session_id: "session-1", leaf_id: "history-1", group_id: "user", timestamp: 0,
  kind: "user", origin: "pwa", sender_ref: "self", status: "committed", delivery: "normal", blocks: [{ type: "text", text: "Hello" }],
};
const items: TimelineViewItem[] = [{ kind: "event", event: userEvent }];

test.each(["standard", "large", "xlarge"] as const)("Working spinner centers its icon slot and label on the 44px row at %s text size", async size => {
  document.documentElement.dataset.pwaTextSize = size;
  const screen = await renderPwa(<main className="pwa-main" style={{ width: "100vw", height: "100vh" }}>
    <MessageList items={items} hasEarlier={false} listRef={createRef<HTMLDivElement>()} bottomSentinelRef={createRef<HTMLDivElement>()} onScroll={() => {}} running isLive />
  </main>);
  await expect.poll(() => document.querySelector(".pwa-turn-activity[data-working]")).not.toBeNull();
  const slot = document.querySelector<HTMLElement>(".pwa-turn-activity")!;
  const icon = slot.querySelector<HTMLElement>(".pwa-working-icon")!;
  const spinner = icon.querySelector<SVGSVGElement>(".pwa-spin")!;
  const label = slot.querySelector<HTMLElement>(".pwa-working-label")!;
  // 旋转只作用在槽内的 svg；位置按外槽与活动区整行判定，不用旋转后的 svg 包围盒。外槽与行内图标同宽，随字号档位放大。
  const inline = { standard: 16, large: 18, xlarge: 20 }[size];
  expect([rounded(icon.getBoundingClientRect().width), rounded(icon.getBoundingClientRect().height)]).toEqual([inline, inline]);
  expect([getComputedStyle(spinner).width, getComputedStyle(spinner).height]).toEqual([`${inline}px`, `${inline}px`]);
  // 实际线宽固定 1.5px：换算回 24 画布的线宽随尺寸变化。
  expect(Number.parseFloat(getComputedStyle(spinner).strokeWidth)).toBeCloseTo(1.5 * 24 / inline, 3);
  expect(center(icon.getBoundingClientRect())).toBe(center(slot.getBoundingClientRect()));
  expect(center(label.getBoundingClientRect())).toBe(center(slot.getBoundingClientRect()));
  expect(rounded(label.getBoundingClientRect().left - icon.getBoundingClientRect().right)).toBe(6);
  expect(rounded(slot.getBoundingClientRect().height)).toBe(44);
  await screen.unmount();
});

test("Working spinner keeps its slot, row and text while rotating", async () => {
  const screen = await renderPwa(<main className="pwa-main" style={{ width: "100vw", height: "100vh" }}>
    <MessageList items={items} hasEarlier={false} listRef={createRef<HTMLDivElement>()} bottomSentinelRef={createRef<HTMLDivElement>()} onScroll={() => {}} running isLive />
  </main>);
  await expect.poll(() => document.querySelector(".pwa-turn-activity")).not.toBeNull();
  const slot = document.querySelector<HTMLElement>(".pwa-turn-activity")!;
  const working = slot.querySelector<HTMLElement>(".pwa-turn-activity-working")!;
  const icon = slot.querySelector<HTMLElement>(".pwa-working-icon")!;
  const spinner = icon.querySelector<SVGSVGElement>(".pwa-spin")!;
  const label = slot.querySelector<HTMLElement>(".pwa-working-label")!;
  // Working 不可见时旋转必须暂停；显隐只控制透明度，不改变布局。
  expect(getComputedStyle(spinner).animationPlayState).toBe("paused");
  const style = getComputedStyle(slot);
  expect(style.fontSize).toBe("16px");
  expect(style.marginTop).toBe("6px");
  expect(style.minHeight).toBe("44px");
  expect(getComputedStyle(label).fontWeight).toBe("600");
  expect(getComputedStyle(working).lineHeight).toBe(style.lineHeight);
  expect(getComputedStyle(spinner).color).toBe(style.color);
  const lineHeight = style.lineHeight;
  const before = {
    slot: [rounded(slot.getBoundingClientRect().left), rounded(slot.getBoundingClientRect().top), rounded(slot.getBoundingClientRect().height)],
    icon: [rounded(icon.getBoundingClientRect().left), rounded(icon.getBoundingClientRect().top), rounded(icon.getBoundingClientRect().width)],
    label: [rounded(label.getBoundingClientRect().left), rounded(label.getBoundingClientRect().top), rounded(label.getBoundingClientRect().width)],
    color: getComputedStyle(spinner).color,
  };
  const geometry = () => ({
    slot: [rounded(slot.getBoundingClientRect().left), rounded(slot.getBoundingClientRect().top), rounded(slot.getBoundingClientRect().height)],
    icon: [rounded(icon.getBoundingClientRect().left), rounded(icon.getBoundingClientRect().top), rounded(icon.getBoundingClientRect().width)],
    label: [rounded(label.getBoundingClientRect().left), rounded(label.getBoundingClientRect().top), rounded(label.getBoundingClientRect().width)],
  });
  // 等待 Working 真实显示后旋转：只改旋转角度，槽位、文字和行高不动。
  await expect.poll(() => document.querySelector(".pwa-turn-activity[data-working]")).not.toBeNull();
  await expect.poll(() => getComputedStyle(spinner).animationPlayState).toBe("running");
  const animation = spinner.getAnimations()[0]!;
  expect(animation).toBeTruthy();
  animation.pause();
  await animation.ready;
  const duration = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pwa-duration-spin"));
  animation.currentTime = 0;
  const started = getComputedStyle(spinner).transform;
  animation.currentTime = (duration * 1000) / 4;
  expect(getComputedStyle(spinner).transform).not.toBe(started);
  expect(geometry()).toEqual({ slot: before.slot, icon: before.icon, label: before.label });
  expect(getComputedStyle(slot).lineHeight).toBe(lineHeight);
  expect(getComputedStyle(spinner).color).toBe(before.color);
  await screen.unmount();
});

test("Working pauses and resumes the real animation for reduced motion without moving text", async () => {
  // 独立实例只读取动画，不调用 pause/play；脚本改写的播放状态不能作为 CSS 生命周期的验收对象。
  const screen = await renderPwa(<main className="pwa-main" style={{ width: "100vw", height: "100vh" }}>
    <MessageList items={items} hasEarlier={false} listRef={createRef<HTMLDivElement>()} bottomSentinelRef={createRef<HTMLDivElement>()} onScroll={() => {}} running isLive />
  </main>);
  const slot = document.querySelector<HTMLElement>(".pwa-turn-activity")!;
  const working = slot.querySelector<HTMLElement>(".pwa-turn-activity-working")!;
  const icon = slot.querySelector<HTMLElement>(".pwa-working-icon")!;
  const spinner = icon.querySelector<SVGSVGElement>(".pwa-spin")!;
  const label = slot.querySelector<HTMLElement>(".pwa-working-label")!;
  expect(getComputedStyle(spinner).animationPlayState).toBe("paused");
  const animation = spinner.getAnimations()[0]!;
  expect(animation).toBeTruthy();
  await expect.poll(() => getComputedStyle(working).opacity).toBe("1");
  await expect.poll(() => animation.playState).toBe("running");
  await expect.poll(() => Number(animation.currentTime)).toBeGreaterThan(0);
  const geometry = () => [slot, icon, label].map(element => {
    const box = element.getBoundingClientRect();
    return [rounded(box.left), rounded(box.top), rounded(box.width), rounded(box.height)];
  });
  const before = geometry();
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await expect.poll(() => animation.playState).toBe("paused");
  await animation.ready;
  const pausedTime = animation.currentTime;
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  expect(animation.currentTime).toBe(pausedTime);
  expect(getComputedStyle(spinner).opacity).toBe("1");
  expect(spinner.checkVisibility({ visibilityProperty: true, opacityProperty: true })).toBe(true);
  expect(geometry()).toEqual(before);
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await expect.poll(() => animation.playState).toBe("running");
  await expect.poll(() => Number(animation.currentTime)).toBeGreaterThan(Number(pausedTime));
  expect(spinner.getAnimations()[0]).toBe(animation);
  expect(geometry()).toEqual(before);
  await screen.unmount();
});
