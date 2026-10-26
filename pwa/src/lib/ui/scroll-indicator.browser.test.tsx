import { afterEach, expect, test } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { SCROLL_HIDE_DELAY_MS, SCROLL_HINTS_ATTRIBUTE, SCROLLING_ATTRIBUTE, useScrollIndicator } from "./scroll-indicator";

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

test.each(["light", "dark"])("idle scroll areas keep thin, hidden bars in %s", async theme => {
  document.documentElement.setAttribute("data-mantine-color-scheme", theme);
  await renderPwa(<Scrollers />);
  for (const name of ["table", "other"]) {
    expect(getComputedStyle(scroller(name)).scrollbarWidth).toBe("thin");
    expect(scrollbarColor(name)).toBe(hiddenColor);
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
    expect(getComputedStyle(target).scrollbarWidth, selector).toBe("thin");
    expect(getComputedStyle(target).scrollbarColor, selector).toBe(hiddenColor);
  }
});

test("scrolling one container reveals only its bar, then hides it", async () => {
  await renderPwa(<Scrollers />);
  const table = scroller("table");
  table.scrollLeft = 40;

  await expect.poll(() => table.hasAttribute(SCROLLING_ATTRIBUTE)).toBe(true);
  expect(scrollbarColor("table")).toBe(`${controlLineColor()} rgba(0, 0, 0, 0)`);
  expect(scrollbarColor("other")).toBe(hiddenColor);

  await expect.poll(() => table.hasAttribute(SCROLLING_ATTRIBUTE), { timeout: SCROLL_HIDE_DELAY_MS + 1200 }).toBe(false);
  expect(scrollbarColor("table")).toBe(hiddenColor);
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

test("hiding is gated by the mount flag and cleaned up on unmount", async () => {
  const screen = await renderPwa(<Scrollers />);
  expect(document.documentElement.hasAttribute(SCROLL_HINTS_ATTRIBUTE)).toBe(true);
  await screen.unmount();
  expect(document.documentElement.hasAttribute(SCROLL_HINTS_ATTRIBUTE)).toBe(false);
});

test("scroll areas stay visible when the indicator is not mounted", async () => {
  await renderPwa(<div className="pwa-markdown-table" data-scroller="plain" />);
  expect(getComputedStyle(scroller("plain")).scrollbarWidth).toBe("thin");
  expect(scrollbarColor("plain")).toBe(`${controlLineColor()} rgba(0, 0, 0, 0)`);
});
