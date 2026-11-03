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

test("reduced motion shows a static ring beside the filled completed dot", async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const screen = await renderPwa(<RowHarness initial={{ working: true, current: false, completed: true }} />);
  const dot = document.querySelector<HTMLElement>(".pwa-running-indicator-dot")!;
  const style = getComputedStyle(dot);
  expect(style.animationPlayState).toBe("paused");
  expect(style.opacity).toBe("1");
  expect(style.borderTopWidth).toBe("1px");
  expect(style.borderTopStyle).toBe("solid");
  updateRow({ working: false, current: false, completed: true });
  const completed = document.querySelector<HTMLElement>(".pwa-notice-dot")!;
  expect(getComputedStyle(completed).backgroundColor).not.toBe(style.backgroundColor);
  await screen.unmount();
});

test("breathing dot uses its stronger opacity token without changing the skeleton range", async () => {
  const screen = await renderPwa(<div style={{ padding: 20 }}><RunningIndicator size="compact" /><RunningIndicator /></div>);
  const dots = [...document.querySelectorAll<HTMLElement>(".pwa-running-indicator-dot")];
  expect([rounded(dots[0]!.getBoundingClientRect().width), rounded(dots[1]!.getBoundingClientRect().width)]).toEqual([6, 8]);
  const theme = getComputedStyle(document.documentElement);
  const breathe = theme.getPropertyValue("--pwa-opacity-running-breathe").trim();
  expect(breathe).toBe("0.48");
  expect(theme.getPropertyValue("--pwa-opacity-breathe").trim()).toBe("0.72");
  const duration = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pwa-duration-breathe"));
  const animation = dots[0]!.getAnimations()[0]!;
  expect(animation).toBeTruthy();
  animation.pause();
  animation.currentTime = 0;
  expect(getComputedStyle(dots[0]!).opacity).toBe(breathe);
  expect(getComputedStyle(dots[0]!).transform).toBe("none");
  const geometryBefore = dots.map(dot => [rounded(dot.getBoundingClientRect().left), rounded(dot.getBoundingClientRect().top), rounded(dot.getBoundingClientRect().width)]);
  animation.currentTime = (duration * 1000) / 2;
  expect(getComputedStyle(dots[0]!).opacity).toBe("1");
  expect(getComputedStyle(dots[0]!).transform).toBe("none");
  expect(dots.map(dot => [rounded(dot.getBoundingClientRect().left), rounded(dot.getBoundingClientRect().top), rounded(dot.getBoundingClientRect().width)])).toEqual(geometryBefore);
  animation.play();
  await screen.unmount();
});

const userEvent: TimelineEvent = {
  event_id: "user", message_id: "user", session_id: "session-1", leaf_id: "history-1", group_id: "user", timestamp: 0,
  kind: "user", origin: "pwa", sender_ref: "self", status: "committed", delivery: "normal", blocks: [{ type: "text", text: "Hello" }],
};
const items: TimelineViewItem[] = [{ kind: "event", event: userEvent }];

test.each(["standard", "large", "xlarge"] as const)("Working dot follows the text middle at %s text size", async size => {
  document.documentElement.dataset.pwaTextSize = size;
  const screen = await renderPwa(<main className="pwa-main" style={{ width: "100vw", height: "100vh" }}>
    <MessageList items={items} hasEarlier={false} listRef={createRef<HTMLDivElement>()} bottomSentinelRef={createRef<HTMLDivElement>()} onScroll={() => {}} running isLive />
  </main>);
  await expect.poll(() => document.querySelector(".pwa-turn-activity[data-working]")).not.toBeNull();
  const label = document.querySelector<HTMLElement>(".pwa-working-label")!;
  const indicator = document.querySelector<HTMLElement>(".pwa-turn-activity .pwa-running-indicator")!;
  // middle 对齐到基线以上半个 x-height；使用当前字体的 ex 测量，不写死像素补偿。
  const probe = document.createElement("span");
  probe.style.cssText = "display:inline-block;width:0;height:1ex;vertical-align:baseline";
  label.append(probe);
  try {
    expect(center(rect(".pwa-turn-activity .pwa-running-indicator-dot"))).toBe(center(probe.getBoundingClientRect()));
    expect(rounded(label.getBoundingClientRect().left - indicator.getBoundingClientRect().right)).toBe(6);
    expect(rounded(rect(".pwa-turn-activity").height)).toBe(44);
  } finally {
    probe.remove();
  }
  await screen.unmount();
});

test("Working keeps its 16px slot, 8px dot and unchanged text metrics", async () => {
  const screen = await renderPwa(<main className="pwa-main" style={{ width: "100vw", height: "100vh" }}>
    <MessageList items={items} hasEarlier={false} listRef={createRef<HTMLDivElement>()} bottomSentinelRef={createRef<HTMLDivElement>()} onScroll={() => {}} running isLive />
  </main>);
  await expect.poll(() => document.querySelector(".pwa-turn-activity")).not.toBeNull();
  const slot = document.querySelector<HTMLElement>(".pwa-turn-activity")!;
  const working = slot.querySelector<HTMLElement>(".pwa-turn-activity-working")!;
  const label = slot.querySelector<HTMLElement>(".pwa-working-label")!;
  const indicator = slot.querySelector<HTMLElement>(".pwa-running-indicator")!;
  const dot = slot.querySelector<HTMLElement>(".pwa-running-indicator-dot")!;
  // Working 未显示时点也必须暂停；显隐只控制透明度。
  expect(getComputedStyle(dot).animationPlayState).toBe("paused");
  expect([rounded(indicator.getBoundingClientRect().width), rounded(indicator.getBoundingClientRect().height)]).toEqual([16, 16]);
  expect([rounded(dot.getBoundingClientRect().width), rounded(dot.getBoundingClientRect().height)]).toEqual([8, 8]);
  const style = getComputedStyle(slot);
  expect(style.fontSize).toBe("16px");
  expect(style.marginTop).toBe("6px");
  expect(style.minHeight).toBe("44px");
  expect(getComputedStyle(label).fontWeight).toBe("600");
  expect(rounded(label.getBoundingClientRect().left - indicator.getBoundingClientRect().right)).toBe(6);
  expect(getComputedStyle(working).lineHeight).toBe(style.lineHeight);
  expect(getComputedStyle(dot).backgroundColor).toBe(getComputedStyle(slot).color);
  const lineHeight = style.lineHeight;
  const before = {
    slot: [rounded(slot.getBoundingClientRect().left), rounded(slot.getBoundingClientRect().top), rounded(slot.getBoundingClientRect().height)],
    label: [rounded(label.getBoundingClientRect().left), rounded(label.getBoundingClientRect().top), rounded(label.getBoundingClientRect().width)],
    dot: getComputedStyle(dot).backgroundColor,
  };
  // 等待 Working 真实显示后切减少动态效果：真实点静音、全亮、保持实心，行高与文字位置不变。
  await expect.poll(() => document.querySelector(".pwa-turn-activity[data-working]")).not.toBeNull();
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await expect.poll(() => getComputedStyle(dot).animationPlayState).toBe("paused");
  expect(getComputedStyle(dot).opacity).toBe("1");
  expect(getComputedStyle(dot).borderTopWidth).toBe("0px");
  expect(getComputedStyle(dot).backgroundColor).toBe(before.dot);
  expect([rounded(slot.getBoundingClientRect().left), rounded(slot.getBoundingClientRect().top), rounded(slot.getBoundingClientRect().height)]).toEqual(before.slot);
  expect([rounded(label.getBoundingClientRect().left), rounded(label.getBoundingClientRect().top), rounded(label.getBoundingClientRect().width)]).toEqual(before.label);
  expect(getComputedStyle(slot).lineHeight).toBe(lineHeight);
  await screen.unmount();
});
