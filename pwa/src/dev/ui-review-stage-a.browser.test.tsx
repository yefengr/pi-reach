import { afterEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { getMessages, setLanguagePreference } from "@/lib/i18n";
import { UiReviewStageAPage } from "./ui-review-stage-a";

const root = () => document.querySelector<HTMLElement>(".pwa-stage-a")!;
const cell = (testId: string) => root().querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.closest<HTMLElement>(".pwa-review-compare-cell")!;

/**
 * vitest 浏览器模式把测试页放在缩放过的 iframe 中，CDP 鼠标坐标无法可靠命中元素，
 * 因此这里只校验样式规则本身；按住不放的真实按压效果由 Playwright 验收脚本覆盖。
 */
function styleRules(): { selector: string; declarations: Record<string, string> }[] {
  const found: { selector: string; declarations: Record<string, string> }[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        const declarations: Record<string, string> = {};
        for (const property of rule.style) declarations[property] = rule.style.getPropertyValue(property).trim();
        found.push({ selector: rule.selectorText, declarations });
      } else if (rule instanceof CSSMediaRule) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules); } catch { /* 跨域样式表不参与断言 */ }
  }
  return found;
}

function pressRules(variant: string): Record<string, string>[] {
  return styleRules()
    .filter((rule) => rule.selector.includes(`[data-variant="${variant}"]`) && rule.selector.includes(":active"))
    .map((rule) => rule.declarations);
}

/** 切换时长在不同浏览器里可能序列化为 "0.15s" 或 "150ms"，统一取毫秒数。 */
function durationMs(value: string): number[] {
  return value.split(",").map((part) => {
    const text = part.trim();
    const seconds = /([\d.]+)s$/.exec(text);
    return seconds ? Math.round(Number.parseFloat(seconds[1]) * 1000) : Number.parseFloat(text);
  });
}

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  vi.restoreAllMocks();
  setLanguagePreference("system");
  await page.viewport(1280, 900);
});

test("stage A page puts the current build and the candidate side by side with equal cells", async () => {
  const storage = JSON.stringify({ ...localStorage });
  const screen = await render(<UiReviewStageAPage />);
  expect(root().dataset.layout).toBe("compare");
  const cells = [...root().querySelectorAll<HTMLElement>(".pwa-review-compare-cell")];
  expect(cells.map((node) => node.dataset.variant)).toEqual(["baseline", "candidate", "baseline", "candidate", "baseline", "candidate"]);
  const columns = [...root().querySelectorAll<HTMLElement>(".pwa-review-compare-head")].map((head) => Math.round(head.getBoundingClientRect().width));
  expect(new Set(columns).size).toBe(1);
  await screen.getByRole("button", { name: "深色", exact: true }).click();
  await screen.getByRole("button", { name: "浅色", exact: true }).click();
  expect(JSON.stringify({ ...localStorage })).toBe(storage);
});

test("candidate press shrinks the drawing layer while the hit area stays put", async () => {
  await render(<UiReviewStageAPage />);
  const candidate = pressRules("candidate");
  expect(candidate.some((rule) => rule.transform === "scale(0.97)")).toBe(true);
  expect(candidate.some((rule) => rule.transform === "scale(0.985)")).toBe(true);
  expect(candidate.some((rule) => rule["transition-duration"] === "90ms")).toBe(true);
  // 基线显式隔离正式默认的缩放，按压只换底色。
  expect(pressRules("baseline").some((rule) => rule.transform === "none")).toBe(true);
  // 两列控件几何一致：按压只作用于绘制层，不改变点击区。
  const geometry = ["baseline", "candidate"].map((variant) => [...cell(`stage-a-press-${variant}`).querySelectorAll<HTMLElement>("button")]
    .map((button) => { const box = button.getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)]; }));
  expect(geometry[1]).toEqual(geometry[0]);
  expect(geometry[0].every(([width, height]) => width >= 44 && height >= 44)).toBe(true);
});

test("historical press specimens keep baseline layers still and avoid doubling candidate scale", async () => {
  const screen = await render(<UiReviewStageAPage />);
  for (const variant of ["baseline", "candidate"] as const) {
    const button = screen.getByTestId(`stage-a-button-${variant}`).element() as HTMLButtonElement;
    const icon = cell(`stage-a-press-${variant}`).querySelector<HTMLButtonElement>(".pwa-composer-icon")!;
    const readScale = (element: Element, pseudo?: string) => {
      const value = getComputedStyle(element, pseudo).transform;
      return new DOMMatrix(value === "none" ? undefined : value).m11;
    };
    for (const target of [button, icon]) {
      target.focus();
      await userEvent.keyboard("{Space>}");
      const inner = target.querySelector(".mantine-Button-inner, .mantine-ActionIcon-icon")!;
      expect(readScale(inner)).toBe(1);
      if (target === icon) await expect.poll(() => readScale(target, "::before")).toBeCloseTo(variant === "candidate" ? 0.97 : 1, 2);
      else await expect.poll(() => readScale(target)).toBeCloseTo(variant === "candidate" ? 0.985 : 1, 3);
      await userEvent.keyboard("{/Space}");
    }
  }
});

test("candidate press drops the scale when reduced motion is requested", async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const screen = await render(<UiReviewStageAPage />);
  await expect.element(screen.getByTestId("stage-a-motion")).toHaveTextContent("已生效");
  const reduced = styleRules().filter((rule) => rule.selector.includes('data-variant="candidate"')
    && rule.selector.includes(":active") && rule.declarations.transform === "none");
  expect(reduced.length).toBeGreaterThan(0);
});

test("candidate menu animates with scale and a longer enter while rows stay identical", async () => {
  const screen = await render(<UiReviewStageAPage />);
  const durations: Record<string, number[]> = {};
  const rowHeights: Record<string, number> = {};
  for (const variant of ["baseline", "candidate"] as const) {
    await screen.getByTestId(`stage-a-menu-trigger-${variant}`).click();
    const dropdown = document.querySelector<HTMLElement>(`[data-testid="stage-a-menu-${variant}"]`)!;
    await expect.poll(() => getComputedStyle(dropdown).opacity).toBe("1");
    durations[variant] = durationMs(getComputedStyle(dropdown).transitionDuration);
    expect(getComputedStyle(dropdown).transformOrigin.startsWith(variant === "candidate" ? "0px 0px" : "")).toBe(true);
    const row = dropdown.querySelector<HTMLElement>(".pwa-command-row")!;
    rowHeights[variant] = Math.round(row.getBoundingClientRect().height);
    await cdp().send("Input.dispatchMouseEvent", { type: "mousePressed", x: 8, y: 8, button: "left", buttons: 1, clickCount: 1 });
    await cdp().send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 8, y: 8, button: "left", buttons: 0, clickCount: 1 });
    await expect.poll(() => document.querySelector(`[data-testid="stage-a-menu-${variant}"]:not([inert])`)).toBeNull();
  }
  expect(Math.max(...durations.baseline)).toBe(120);
  expect(Math.max(...durations.candidate)).toBe(150);
  // 两列行密度一致，避免同时比较动效与密度两件事。
  expect(rowHeights.candidate).toBe(rowHeights.baseline);
});

test("candidate attachment cards lift onto the operation surface without changing height or hit area", async () => {
  await render(<UiReviewStageAPage />);
  const read = (variant: string) => {
    const cards = [...cell(`stage-a-attachments-${variant}`).querySelectorAll<HTMLElement>(".pwa-attachment-card")];
    const first = cards[0];
    const style = getComputedStyle(first);
    const actions = [...cell(`stage-a-attachments-${variant}`).querySelectorAll<HTMLElement>(".pwa-attachment-actions button")];
    return {
      count: cards.length,
      heights: cards.map((card) => Math.round(card.getBoundingClientRect().height)),
      radius: style.borderRadius,
      background: style.backgroundColor,
      shadow: style.boxShadow,
      targets: actions.map((button) => [Math.round(button.getBoundingClientRect().width), Math.round(button.getBoundingClientRect().height)]),
    };
  };
  const baseline = read("baseline");
  const candidate = read("candidate");
  expect(baseline.count).toBe(6);
  expect(candidate.count).toBe(6);
  expect(new Set(baseline.heights)).toEqual(new Set([58]));
  expect(candidate.heights).toEqual(baseline.heights);
  expect(candidate.targets).toEqual(baseline.targets);
  expect(candidate.targets.every(([width, height]) => width >= 44 && height >= 44)).toBe(true);
  expect(baseline.radius).toBe("8px");
  expect(candidate.radius).toBe("10px");
  expect(baseline.shadow).toBe("none");
  expect(candidate.shadow).not.toBe("none");
  expect(candidate.background).not.toBe(baseline.background);
});

test("slow motion scales only duration tokens and restores them", async () => {
  const screen = await render(<UiReviewStageAPage />);
  const read = (token: string) => getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  expect(read("--pwa-duration-fade")).toBe("120ms");
  expect(read("--pwa-duration-modal-in")).toBe("180ms");
  expect(read("--pwa-duration-menu-in")).toBe("160ms");
  expect(read("--pwa-duration-press-in")).toBe("90ms");
  await screen.getByRole("button", { name: "0.25× 慢放", exact: true }).click();
  await expect.poll(() => read("--pwa-duration-fade")).toBe("480ms");
  expect(read("--pwa-duration-modal-in")).toBe("720ms");
  expect(read("--pwa-duration-menu-in")).toBe("640ms");
  expect(read("--pwa-duration-press-in")).toBe("360ms");
  expect(read("--pwa-duration-feedback")).toBe("480ms");
  // 完成态刻意停留不受慢放影响。
  expect(read("--pwa-duration-fetch-settle")).toBe("600ms");
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await expect.poll(() => read("--pwa-duration-fade")).toBe("120ms");
  expect(read("--pwa-duration-menu-in")).toBe("120ms");
  expect(read("--pwa-duration-fetch-settle")).toBe("600ms");
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await expect.poll(() => read("--pwa-duration-menu-in")).toBe("640ms");
  await screen.getByRole("button", { name: "1×", exact: true }).click();
  await expect.poll(() => read("--pwa-duration-fade")).toBe("120ms");
  expect(read("--pwa-duration-modal-in")).toBe("180ms");
  expect(read("--pwa-duration-menu-in")).toBe("160ms");
  expect(getMessages().common.back.length).toBeGreaterThan(0);
});

test("warm surface swaps only the neutral surfaces and keeps text roles unchanged", async () => {
  const screen = await render(<UiReviewStageAPage />);
  const read = (token: string) => getComputedStyle(root()).getPropertyValue(token).trim();
  const sample = () => root().querySelector<HTMLElement>('[data-testid="stage-a-surface-sample"] p')!;
  const neutralBg = read("--pwa-bg");
  const neutralInk = getComputedStyle(sample()).color;
  // 自定义属性返回声明文本而非计算后的颜色。
  expect(neutralBg).toBe("#FFFFFF");
  await screen.getByRole("button", { name: "暖灰", exact: true }).click();
  await expect.poll(() => read("--pwa-bg")).not.toBe(neutralBg);
  expect(read("--pwa-bg")).toBe("rgb(253 251 247)");
  expect(read("--pwa-panel")).toBe("rgb(247 243 236)");
  // 文字与主色不随表面色变化。
  expect(getComputedStyle(sample()).color).toBe(neutralInk);
  expect(read("--pwa-accent")).toBe(getComputedStyle(document.documentElement).getPropertyValue("--pwa-accent").trim());
  await screen.getByRole("button", { name: "中性灰", exact: true }).click();
  await expect.poll(() => read("--pwa-bg")).toBe(neutralBg);
});
