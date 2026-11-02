import { afterEach, expect, test } from "vitest";
import { useState } from "react";
import { page } from "vitest/browser";
import { Drawer } from "@mantine/core";
import { renderPwa } from "@/test/browser/render";
import { SCROLL_EDGE_ATTRIBUTE, SCROLL_HIDE_DELAY_MS, SCROLL_HINTS_ATTRIBUTE, SCROLL_HOST_ATTRIBUTE, SCROLLING_ATTRIBUTE, useScrollIndicator } from "./scroll-indicator";
// 与生产一致：时间线样式加载在全局样式之后，列表自身的 transition 声明会覆盖 [data-scroll-host]。
import "@/components/pwa/timeline-reconnect.css";
// 阅读器的滚动容器与头部底色由组件样式提供。
import "@/components/pwa/tool-reader.css";

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

/** 收集所有同源样式规则的选择器；嵌套的 @media 等分组规则一并展开。 */
function styleSelectors(): string[] {
  const selectors: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) selectors.push(rule.selectorText);
      if ("cssRules" in rule && rule.cssRules) visit(rule.cssRules as CSSRuleList);
    }
  };
  for (const sheet of document.styleSheets) visit(sheet.cssRules);
  return selectors;
}

test("no style rule depends on a scrolling ancestor, so toggling only restyles the scrolled container", async () => {
  await renderPwa(<IndicatorOnly />);
  const selectors = styleSelectors().flatMap((selector) => selector.split(",")).map((part) => part.trim());
  expect(selectors.some((part) => part.includes("[data-scrolling]"))).toBe(true);
  // [data-scrolling] 之后再出现组合符即为后代依赖：长会话里滚动开始、停止都会让整棵消息子树重新匹配样式。
  expect(selectors.filter((part) => /\[data-scrolling\][^\s>+~]*[\s>+~]/.test(part))).toEqual([]);
});

test("the message list keeps its fade transition and still fades its own bar", async () => {
  await renderPwa(<>
    <IndicatorOnly />
    <div className="pwa-message-list" data-scroller="messages" style={{ flex: "none", height: 120, overflowY: "auto" }}>
      <div style={{ height: 600 }} />
    </div>
  </>);
  const list = scroller("messages");
  list.scrollTop = 40;
  await expect.poll(() => list.hasAttribute(SCROLLING_ATTRIBUTE)).toBe(true);
  expect(getComputedStyle(list).transitionProperty.split(", ").sort()).toEqual(["opacity", "scrollbar-color"]);
  await expect.poll(() => scrollbarColor("messages")).toBe(visibleColor());
});

test("continuous scrolling writes the scrolling flag once", async () => {
  await renderPwa(<Scrollers />);
  const table = scroller("table");
  const writes: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) if (record.attributeName === SCROLLING_ATTRIBUTE) writes.push(record.attributeName);
  });
  observer.observe(table, { attributes: true });
  try {
    for (const left of [20, 40, 60]) {
      table.scrollLeft = left;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    await expect.poll(() => table.hasAttribute(SCROLLING_ATTRIBUTE)).toBe(true);
    observer.takeRecords().forEach((record) => { if (record.attributeName === SCROLLING_ATTRIBUTE) writes.push(record.attributeName); });
    expect(writes).toHaveLength(1);
  } finally { observer.disconnect(); }
});

/** 会话主区、阅读器、电脑选择 Drawer 与移动设置页的最小结构：固定顶栏在上，滚动容器在下；会话主区在两者之间夹着提示区。 */
function EdgeFixture() {
  useScrollIndicator();
  return <>
    <main className="pwa-main" style={{ height: 240 }}>
      <header className="pwa-topbar pwa-title-bar">Session</header>
      <div className="pwa-main-notices"><div style={{ height: 40 }}>Reconnecting</div></div>
      <div className="pwa-message-list" data-scroller="messages" style={{ flex: "1 1 0", overflowY: "auto" }}>
        <div data-testid="first-message" style={{ height: 1200, background: "rgb(0, 0, 0)" }} />
      </div>
      <div className="pwa-chat-footer"><div style={{ height: 60 }}>Composer</div></div>
    </main>
    <section className="pwa-tool-reader" style={{ height: 240 }}>
      <header className="pwa-topbar pwa-tool-reader-header">Reader</header>
      <div className="pwa-tool-reader-body">
        <div className="pwa-tool-reader-scroll" data-scroller="reader"><div style={{ height: 1200 }} /></div>
      </div>
    </section>
    <Drawer opened onClose={() => undefined} position="bottom" withinPortal={false} withOverlay={false} padding={0} title="Computers" transitionProps={{ duration: 0 }}
      classNames={{ content: "pwa-device-drawer", header: "pwa-device-drawer-head", body: "pwa-device-drawer-body" }} styles={{ content: { maxHeight: 240 } }}>
      <div style={{ height: 1200 }} />
    </Drawer>
    <div className="pwa-settings-view" data-scroller="settings" style={{ position: "relative", height: 240 }}>
      <div className="pwa-settings-page"><div className="pwa-settings-inner">
        <header className="pwa-settings-header">Settings</header>
        <div style={{ height: 1200 }} />
      </div></div>
    </div>
  </>;
}

const pseudo = (selector: string, which: "::before" | "::after") => getComputedStyle(document.querySelector(selector)!, which);
/** 渐变第一个色标：必须与顶栏底色一致，渐变才能从顶栏无缝接出。 */
const gradientStart = (style: CSSStyleDeclaration) => /linear-gradient\((rgba?\([^)]*\))/.exec(style.backgroundImage)?.[1];

/** 按滚动容器与挂渐变的元素逐一核对：离开顶部淡入、回到顶部淡出，不画分隔线。 */
const topEdges = [
  { name: "messages", host: ".pwa-main-notices", which: "::after" },
  { name: "reader", host: ".pwa-tool-reader-header", which: "::after" },
  { name: "settings", host: ".pwa-settings-header", which: "::after" },
] as const;

test("a fixed top bar fades the content below it while the scroller has left the top, without a hairline", async () => {
  await page.viewport(390, 844);
  await renderPwa(<EdgeFixture />);
  // 会话标题区不再挂分隔或渐变。
  expect(pseudo(".pwa-title-bar", "::after").content).toBe("none");
  for (const { name, host, which } of topEdges) {
    const target = scroller(name);
    expect(target.hasAttribute(SCROLL_EDGE_ATTRIBUTE)).toBe(false);
    expect(pseudo(host, which).opacity).toBe("0");
    expect(pseudo(host, which).backgroundImage).toContain("linear-gradient");
    expect(pseudo(host, which).borderBottomWidth).toBe("0px");
    target.scrollTop = 120;
    await expect.poll(() => pseudo(host, which).opacity, { message: name }).toBe("1");
    target.scrollTop = 0;
    await expect.poll(() => pseudo(host, which).opacity, { message: name }).toBe("0");
  }
});

/** 截取元素并按 CSS 像素读取若干点的 RGB。 */
async function samplePixels(element: HTMLElement, points: ReadonlyArray<readonly [number, number]>) {
  const base64 = await page.screenshot({ element, save: false });
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const scale = image.width / element.getBoundingClientRect().width;
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  return points.map(([x, y]) => Array.from(context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data).slice(0, 3));
}

test("the message list fade starts at the top of the visible list, below the notices", async () => {
  await page.viewport(390, 844);
  await renderPwa(<EdgeFixture />);
  const main = document.querySelector<HTMLElement>(".pwa-main")!;
  const notices = document.querySelector<HTMLElement>(".pwa-main-notices")!;
  const list = scroller("messages");
  // 渐变是流内伪元素，但不改变提示区高度：提示区仍只有提示条的 40px，首条消息仍从 24px 留白之后开始。
  expect(Math.round(notices.getBoundingClientRect().height)).toBe(40);
  const first = document.querySelector("[data-testid='first-message']")!.getBoundingClientRect().top;
  expect(Math.round(first - list.getBoundingClientRect().top)).toBe(24);

  // 黑色内容滚到顶栏下：列表可视区最上沿应是底色，向下逐渐露出内容（sticky 实现会从 24px 留白之下才开始淡化）。
  list.scrollTop = 120;
  await expect.poll(() => pseudo(".pwa-main-notices", "::after").opacity).toBe("1");
  const top = list.getBoundingClientRect().top - main.getBoundingClientRect().top;
  const x = main.getBoundingClientRect().width / 2;
  const [edge, middle, below] = await samplePixels(main, [[x, top + 1], [x, top + 12], [x, top + 30]]);
  expect(Math.min(...edge)).toBeGreaterThan(220);
  expect(Math.max(...middle)).toBeLessThan(220);
  expect(Math.min(...middle)).toBeGreaterThan(20);
  expect(Math.max(...below)).toBeLessThan(20);
});

test.each(["light", "dark"] as const)("scroll-edge fades start from the bar background in %s mode", async (theme) => {
  await page.viewport(390, 844);
  await renderPwa(<EdgeFixture />);
  document.documentElement.setAttribute("data-mantine-color-scheme", theme);
  const background = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor;
  expect(gradientStart(pseudo(".pwa-main-notices", "::after"))).toBe(background(".pwa-main"));
  expect(gradientStart(pseudo(".pwa-tool-reader-header", "::after"))).toBe(background(".pwa-tool-reader-header"));
  expect(gradientStart(pseudo(".pwa-device-drawer-head", "::after"))).toBe(background(".pwa-device-drawer-head"));
  expect(gradientStart(pseudo(".pwa-settings-header", "::after"))).toBe(background(".pwa-settings-header"));
});

test("the device drawer head fades its body while the list has left the top", async () => {
  await page.viewport(390, 844);
  await renderPwa(<EdgeFixture />);
  const body = document.querySelector<HTMLElement>(".pwa-device-drawer-body")!;
  await expect.poll(() => body.scrollHeight > body.clientHeight).toBe(true);
  expect(pseudo(".pwa-device-drawer-head", "::after").opacity).toBe("0");
  body.scrollTop = 120;
  await expect.poll(() => pseudo(".pwa-device-drawer-head", "::after").opacity).toBe("1");
});

test("the message list fades into the composer except at compact height", async () => {
  await page.viewport(390, 844);
  const screen = await renderPwa(<EdgeFixture />);
  const fade = () => pseudo(".pwa-chat-footer", "::before");
  expect(fade().backgroundImage).toContain("linear-gradient");
  expect(fade().pointerEvents).toBe("none");
  const shell = screen.container.querySelector(".pwa-root")!;
  shell.classList.add("pwa-app-shell");
  shell.setAttribute("data-compact-height", "");
  expect(fade().content).toBe("none");
});

test("the desktop settings header scrolls away without a scroll-edge fade", async () => {
  await page.viewport(1280, 900);
  await renderPwa(<EdgeFixture />);
  const settings = scroller("settings");
  settings.scrollTop = 80;
  await expect.poll(() => settings.hasAttribute(SCROLL_EDGE_ATTRIBUTE)).toBe(true);
  expect(pseudo(".pwa-settings-header", "::after").content).toBe("none");
});

test("horizontal scrolling does not mark the scroll edge", async () => {
  await renderPwa(<Scrollers />);
  const table = scroller("table");
  table.scrollLeft = 80;
  await expect.poll(() => table.hasAttribute(SCROLLING_ATTRIBUTE)).toBe(true);
  expect(table.hasAttribute(SCROLL_EDGE_ATTRIBUTE)).toBe(false);
});
