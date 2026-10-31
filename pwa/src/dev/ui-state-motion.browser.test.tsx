import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { UiStateGalleryPage } from "./ui-states";

const root = () => document.documentElement;
const inline = (token: string) => root().style.getPropertyValue(token);
const computed = (element: Element, token: string) => getComputedStyle(element).getPropertyValue(token).trim();
const input = () => document.querySelector<HTMLTextAreaElement>(".pwa-composer textarea")!;
const heads = () => [...document.querySelectorAll<HTMLButtonElement>("button.pwa-process-head")];

async function openMotion() {
  await page.getByLabelText("展示区域", { exact: true }).selectOptions("motion");
  await expect.poll(() => document.querySelector(".pwa-ui-states")?.getAttribute("data-region")).toBe("motion");
}
async function choosePreset(value: "current" | "previous" | "symmetric" | "decelerate") {
  await page.getByLabelText("动效参数 · 仅本页", { exact: true }).selectOptions(value);
}

beforeEach(async () => { await page.viewport(1440, 1000); });
afterEach(() => { vi.restoreAllMocks(); });

test("comparison presets override only the content and space layer and restore on switch back", async () => {
  const screen = await render(<UiStateGalleryPage />);
  await openMotion();
  expect(computed(root(), "--pwa-duration-message-in")).toBe("500ms");
  expect(computed(root(), "--pwa-ease-content")).toMatch(/^linear\(0, /);

  // P2／P3 只写评估期风格属性，不写入存储；按压与菜单的曲线不变。
  await choosePreset("symmetric");
  expect(root().dataset.pwaMotion).toBe("symmetric");
  expect(computed(root(), "--pwa-ease-content")).toBe("cubic-bezier(0.2, 0, 0.2, 1)");
  expect(computed(root(), "--pwa-duration-message-in")).toBe("300ms");
  expect(computed(root(), "--pwa-ease-enter")).toBe("cubic-bezier(0, 0, 0, 1)");
  expect(computed(root(), "--pwa-ease-standard")).toBe("cubic-bezier(0.2, 0, 0, 1)");
  await choosePreset("decelerate");
  expect(computed(root(), "--pwa-ease-content")).toBe("cubic-bezier(0.2, 0, 0, 1)");
  expect(localStorage.getItem("pi-reach-motion-profile")).toBeNull();

  await choosePreset("previous");
  expect(inline("--pwa-duration-message-in")).toBe("160ms");
  expect(inline("--pwa-duration-collapse-out")).toBe("140ms");
  expect(inline("--pwa-duration-collapse-settle")).toBe("320ms");
  expect(inline("--pwa-duration-menu-in")).toBe("");
  expect(inline("--pwa-message-shift")).toBe("6px");
  expect(root().dataset.pwaMotion).toBeUndefined();
  expect(inline("--pwa-ease-content")).toBe("cubic-bezier(0.2, 0, 0, 1)");
  // 旧规范：Modal 与 Toast 还原为陡峭的进入曲线，折叠仍用与现行同值的曲线。
  await page.getByRole("button", { name: "操作确认", exact: true }).click();
  await expect.poll(() => document.querySelector<HTMLElement>(".mantine-Modal-content")?.style.transitionDuration).toBe("180ms");
  expect(computed(document.querySelector(".mantine-Modal-content")!, "--pwa-ease-content")).toBe("cubic-bezier(0, 0, 0, 1)");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector(".mantine-Modal-content")).toBeNull();
  await page.getByRole("button", { name: "成功 Toast", exact: true }).click();
  await expect.poll(() => document.querySelector(".pwa-operation-notification")).not.toBeNull();
  expect(getComputedStyle(document.querySelector(".pwa-operation-notification")!).transitionTimingFunction).toContain("cubic-bezier(0, 0, 0, 1)");
  expect(computed(document.querySelector(".pwa-message-list")!, "--pwa-ease-content")).toBe("cubic-bezier(0.2, 0, 0, 1)");

  await choosePreset("current");
  expect(inline("--pwa-duration-message-in")).toBe("");
  expect(inline("--pwa-message-shift")).toBe("");
  expect(inline("--pwa-ease-content")).toBe("");
  expect(root().dataset.reviewMotion).toBeUndefined();
  expect(root().dataset.pwaMotion).toBeUndefined();
  await screen.unmount();
});

test("slow motion scales preset durations, reduced motion clears every override and unmount restores the theme", async () => {
  const nativeMatchMedia = window.matchMedia.bind(window);
  const media = new EventTarget();
  let reduced = false;
  const query = Object.assign(media, { media: "(prefers-reduced-motion: reduce)", onchange: null, addListener() {}, removeListener() {} });
  Object.defineProperty(query, "matches", { get: () => reduced });
  vi.spyOn(window, "matchMedia").mockImplementation(value => value === query.media ? query as unknown as MediaQueryList : nativeMatchMedia(value));
  const screen = await render(<UiStateGalleryPage />);
  await choosePreset("previous");
  await page.getByRole("button", { name: "动画速度 · 1×", exact: true }).click();
  await expect.poll(() => inline("--pwa-duration-message-in")).toBe("640ms");
  expect(inline("--pwa-duration-fade")).toBe("480ms");
  expect(inline("--pwa-overlay-shift")).toBe("8px");
  reduced = true;
  media.dispatchEvent(new MediaQueryListEvent("change", { matches: true, media: query.media }));
  await expect.poll(() => inline("--pwa-duration-message-in")).toBe("");
  expect(inline("--pwa-overlay-shift")).toBe("");
  expect(root().dataset.reviewMotion).toBeUndefined();
  expect(document.querySelector(".pwa-ui-states-motion")?.textContent).toContain("对比参数不生效");
  reduced = false;
  media.dispatchEvent(new MediaQueryListEvent("change", { matches: false, media: query.media }));
  await expect.poll(() => inline("--pwa-duration-message-in")).toBe("640ms");
  await screen.unmount();
  expect(inline("--pwa-duration-message-in")).toBe("");
  expect(inline("--pwa-duration-fade")).toBe("");
  expect(root().dataset.reviewMotion).toBeUndefined();
});

test("motion workspace sends with the app order and steps a run through automatic collapse", async () => {
  const screen = await render(<UiStateGalleryPage />);
  await openMotion();
  await userEvent.fill(input(), "比较发送过渡");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.querySelector(".pwa-user-message-in")?.textContent).toContain("比较发送过渡");
  expect(input().value).toBe("");

  const before = heads().length;
  const advance = () => page.getByRole("button", { name: /^推进回复/ }).click();
  await advance();
  await expect.poll(() => heads().length).toBe(before + 1);
  await advance();
  await expect.poll(() => document.querySelector(".pwa-tool-card")).not.toBeNull();
  await advance();
  // 正文接续后本轮过程组自动收起。
  await expect.poll(() => heads().at(-1)?.getAttribute("aria-expanded")).toBe("false");
  await advance();
  await expect.poll(() => document.querySelector(".pwa-ui-states-actions [role='status']")?.textContent).toContain("发送消息或推进回复");

  await page.getByRole("button", { name: "重置对话", exact: true }).click();
  await expect.poll(() => heads().length).toBe(before);
  await expect.poll(() => document.querySelector(".pwa-user-message-in")).toBeNull();
  await screen.unmount();
});
