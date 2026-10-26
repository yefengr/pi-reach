import { afterEach, expect, test } from "vitest";
import { useState } from "react";
import { renderPwa } from "@/test/browser/render";
import { SCROLL_HIDE_DELAY_MS, SCROLL_HINTS_ATTRIBUTE, SCROLL_HOST_ATTRIBUTE, SCROLLING_ATTRIBUTE, useScrollIndicator } from "./scroll-indicator";

/** 两个可横滚容器：验证显隐只作用于被滚动的那一个。 */
function Scrollers() {
  useScrollIndicator();
  return <>
    <div className="pwa-markdown-table" data-scroller="table" style={{ width: 160, overflowX: "auto" }}>
      <div style={{ width: 800, height: 24 }} />
    </div>
    <div className="pwa-scroller-sample" data-scroller="other" style={{ width: 160, overflowX: "auto" }}>
      <div style={{ width: 800, height: 24 }} />
    </div>
  </>;
}

/** 仅挂监听，用于只验证容器样式的用例。 */
function IndicatorOnly() {
  useScrollIndicator();
  return null;
}

/** 真实滚动容器的类名：统一规则必须覆盖它们，避免再次出现手工白名单过期。 */
const containerSelectors = [
  ".pwa-navigation-scroll",
  ".pwa-markdown-table",
  ".pwa-code-block pre",
  ".pwa-tool-diff-output",
  ".pwa-file-reader-scroll",
  ".pwa-queued-message-list",
  ".pwa-command-menu-dropdown",
  ".pwa-settings-view",
  ".pwa-workspace-state",
];

const hiddenColor = "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)";
const scroller = (name: string) => document.querySelector<HTMLElement>(`[data-scroller="${name}"]`)!;
const scrollbarColor = (name: string) => getComputedStyle(scroller(name)).scrollbarColor;
const visibleColor = () => `${controlLineColor()} rgba(0, 0, 0, 0)`;

/** 从主题 token 取期望值，避免在测试里重复维护浅/深色值。 */
function controlLineColor() {
  const probe = document.createElement("span");
  probe.style.color = "var(--pwa-control-line)";
  document.querySelector(".pwa-root")!.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

afterEach(() => document.documentElement.removeAttribute("data-mantine-color-scheme"));

test("scroll areas stay visible when the indicator is not mounted", async () => {
  await renderPwa(<div className="pwa-markdown-table" data-scroller="plain" />);
  await expect.poll(() => document.documentElement.hasAttribute(SCROLL_HINTS_ATTRIBUTE)).toBe(false);
  expect(getComputedStyle(scroller("plain")).scrollbarWidth).toBe("thin");
  await expect.poll(() => scrollbarColor("plain")).toBe(visibleColor());
});

test.each(["light", "dark"])("idle scroll areas keep thin, hidden bars in %s", async theme => {
  document.documentElement.setAttribute("data-mantine-color-scheme", theme);
  await renderPwa(<Scrollers />);
  for (const name of ["table", "other"]) {
    expect(getComputedStyle(scroller(name)).scrollbarWidth).toBe("thin");
    await expect.poll(() => scrollbarColor(name)).toBe(hiddenColor);
  }
});

test.each(["light", "dark"])("every real scroll container inherits the unified rule in %s", async theme => {
  document.documentElement.setAttribute("data-mantine-color-scheme", theme);
  await renderPwa(<>
    <IndicatorOnly />
    {containerSelectors.map((selector) => <div key={selector} data-container={selector}>
      {selector === ".pwa-code-block pre"
        ? <div className="pwa-code-block"><pre /></div>
        : <div className={selector.replace(".", "").replace(/ pre$/, "")} />}
    </div>)}
  </>);
  for (const selector of containerSelectors) {
    const target = selector === ".pwa-code-block pre"
      ? document.querySelector<HTMLElement>(".pwa-code-block pre")!
      : document.querySelector<HTMLElement>(`[data-container="${selector}"] > *`)!;
    expect(`${selector}:${getComputedStyle(target).scrollbarWidth}`).toBe(`${selector}:thin`);
    await expect.poll(() => `${selector}:${getComputedStyle(target).scrollbarColor}`).toBe(`${selector}:${hiddenColor}`);
  }
});

test("scrolling one container reveals only its bar, then hides it", async () => {
  await renderPwa(<Scrollers />);
  const table = scroller("table");
  table.scrollLeft = 40;

  await expect.poll(() => table.hasAttribute(SCROLLING_ATTRIBUTE)).toBe(true);
  // 首次滚动同时写入 host 标记，过渡只挂在这些容器上。
  expect(table.hasAttribute(SCROLL_HOST_ATTRIBUTE)).toBe(true);
  expect(getComputedStyle(table).transitionProperty).toBe("scrollbar-color");
  await expect.poll(() => scrollbarColor("table")).toBe(visibleColor());
  expect(scrollbarColor("other")).toBe(hiddenColor);

  await expect.poll(() => table.hasAttribute(SCROLLING_ATTRIBUTE), { timeout: SCROLL_HIDE_DELAY_MS + 1200 }).toBe(false);
  await expect.poll(() => scrollbarColor("table")).toBe(hiddenColor);
});

test("continuous scrolling keeps the bar visible past the hide delay", async () => {
  await renderPwa(<Scrollers />);
  const table = scroller("table");
  table.scrollLeft = 20;
  await expect.poll(() => table.hasAttribute(SCROLLING_ATTRIBUTE)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, SCROLL_HIDE_DELAY_MS / 2));
  table.scrollLeft = 80;
  await new Promise((resolve) => setTimeout(resolve, SCROLL_HIDE_DELAY_MS / 2 + 150));
  expect(table.hasAttribute(SCROLLING_ATTRIBUTE)).toBe(true);
});

/** 外层滚动容器内嵌一个可横滚容器：验证显示只作用于被滚动的那个容器。 */
function NestedScrollers() {
  useScrollIndicator();
  return <div data-scroller="outer" style={{ width: 200, height: 120, overflow: "auto" }}>
    <div style={{ width: 600, height: 600 }}>
      <div data-scroller="inner" style={{ width: 120, overflowX: "auto" }}>
        <div style={{ width: 400, height: 20 }} />
      </div>
    </div>
  </div>;
}

test("scrolling an outer container does not reveal nested container bars", async () => {
  await renderPwa(<NestedScrollers />);
  const outer = scroller("outer");
  const inner = scroller("inner");
  outer.scrollTop = 40;

  await expect.poll(() => outer.hasAttribute(SCROLLING_ATTRIBUTE)).toBe(true);
  await expect.poll(() => scrollbarColor("outer")).toBe(visibleColor());
  // 子容器没有滚动，不应继承父容器的可见颜色。
  expect(scrollbarColor("inner")).toBe(hiddenColor);

  inner.scrollLeft = 40;
  await expect.poll(() => inner.hasAttribute(SCROLLING_ATTRIBUTE)).toBe(true);
  await expect.poll(() => scrollbarColor("inner")).toBe(visibleColor());
});

/** 加载更早记录期间（data-scroll-hold）即使滚动也不显示，加载结束后再显示新长度。 */
function HeldScroller() {
  useScrollIndicator();
  const [hold, setHold] = useState(true);
  return <>
    <button type="button" onClick={() => setHold(false)}>release</button>
    <div className="pwa-markdown-table" data-scroller="table" data-scroll-hold={hold ? "true" : undefined} style={{ width: 160, overflowX: "auto" }}>
      <div style={{ width: 800, height: 24 }} />
    </div>
  </>;
}

test("loading earlier records holds the bar hidden until released", async () => {
  await renderPwa(<HeldScroller />);
  const table = scroller("table");
  table.scrollLeft = 40;

  await expect.poll(() => table.hasAttribute(SCROLLING_ATTRIBUTE)).toBe(true);
  expect(scrollbarColor("table")).toBe(hiddenColor);

  document.querySelector<HTMLButtonElement>("button")!.click();
  await expect.poll(() => table.hasAttribute("data-scroll-hold")).toBe(false);
  await expect.poll(() => scrollbarColor("table")).toBe(visibleColor());
});

test("hiding is gated by the mount flag and cleaned up on unmount", async () => {
  const screen = await renderPwa(<Scrollers />);
  expect(document.documentElement.hasAttribute(SCROLL_HINTS_ATTRIBUTE)).toBe(true);
  await screen.unmount();
  expect(document.documentElement.hasAttribute(SCROLL_HINTS_ATTRIBUTE)).toBe(false);
});
