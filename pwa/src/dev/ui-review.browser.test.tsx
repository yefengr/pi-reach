import { afterEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { getMessages, setLanguagePreference } from "@/lib/i18n";
import { APPEARANCE_STORAGE_KEY } from "@/lib/ui/appearance";
import { UiReviewPage } from "./ui-review";
import { UI_REVIEW_CODE, UI_REVIEW_DRAFT, UI_REVIEW_MODELS, UI_REVIEW_TEXT } from "./ui-review-fixtures";

type Variant = "baseline" | "candidate" | "deepseek";
const VARIANT_LABELS: Record<Variant, string> = { baseline: "当前版", candidate: "原候选", deepseek: "DS 候选" };


const root = () => document.querySelector<HTMLElement>(".pwa-ui-review")!;
const menu = () => document.querySelector<HTMLElement>('.pwa-review-menu:not([inert])');
/** 版本按钮在页面头部，复制区与结果行同样存在 role="status"，查询需限定在试件内。 */
const copyStatus = () => root().querySelector<HTMLElement>(".pwa-copy-inline .pwa-copy-inline-status")!;
const copyAnnouncement = () => root().querySelector<HTMLElement>('.pwa-copy-inline [role="status"]')!;
const composerCard = () => root().querySelector<HTMLElement>(".pwa-composer-card")!;

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  vi.restoreAllMocks();
  setLanguagePreference("system");
  await page.viewport(1280, 900);
});

test("one real composer preserves the draft through A/B, width, appearance and local send", async () => {
  const appearance = localStorage.getItem(APPEARANCE_STORAGE_KEY);
  const storage = JSON.stringify({ ...localStorage });
  const screen = await render(<UiReviewPage />);
  const input = screen.getByRole("textbox");
  await expect.element(input).toHaveValue(UI_REVIEW_DRAFT);
  const composer = root().querySelector(".pwa-composer");
  await input.fill("连续草稿 / continuous draft");
  await screen.getByRole("button", { name: "原候选", exact: true }).click();
  await screen.getByRole("button", { name: "窄 · 320", exact: true }).click();
  await screen.getByRole("button", { name: "深色", exact: true }).click();
  expect(root().dataset.variant).toBe("candidate");
  expect(root().querySelector(".pwa-composer")).toBe(composer);
  expect(document.querySelectorAll(".pwa-root")).toHaveLength(1);
  expect(getComputedStyle(root().querySelector(".pwa-composer-card")!).borderRadius).toBe("16px");
  await expect.element(input).toHaveValue("连续草稿 / continuous draft");
  expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe(appearance);
  expect(JSON.stringify({ ...localStorage })).toBe(storage);
  await screen.getByRole("button", { name: getMessages().composer.send, exact: true }).click();
  await expect.element(screen.getByText("演示发送（不会发送到 Pi）：连续草稿 / continuous draft", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "当前版", exact: true }).click();
  await expect.element(input).toHaveValue("连续草稿 / continuous draft");
  expect(getComputedStyle(root().querySelector(".pwa-composer-card")!).borderRadius).toBe("12px");
  await screen.getByRole("button", { name: "DS 候选", exact: true }).click();
  await expect.element(input).toHaveValue("连续草稿 / continuous draft");
  expect(root().querySelector(".pwa-composer")).toBe(composer);
  expect(root().querySelector(".pwa-review-specimen")!.getBoundingClientRect().width).toBeLessThanOrEqual(320);
});

test("real menu portals into the unique root, navigates back, selects and returns focus", async () => {
  const screen = await render(<UiReviewPage />);
  const trigger = screen.getByRole("button", { name: "打开模型与思考菜单", exact: true });
  trigger.element().focus();
  await trigger.click();
  await expect.poll(menu).not.toBeNull();
  expect(menu()!.closest(".pwa-root")).toBe(root());
  await screen.getByRole("menuitem", { name: new RegExp(getMessages().commands.changeModel) }).click();
  const longModel = screen.getByRole("menuitem", { name: /长名称模型/ });
  await expect.element(longModel).toBeVisible();
  expect(getComputedStyle(longModel.element().querySelector(".pwa-command-copy > span")!).whiteSpace).toBe("normal");
  await screen.getByRole("menuitem", { name: getMessages().common.back, exact: true }).click();
  await screen.getByRole("menuitem", { name: new RegExp(getMessages().commands.thinkingLevel) }).click();
  await screen.getByRole("menuitem", { name: "high", exact: true }).click();
  await expect.poll(menu).toBeNull();
  await expect.element(trigger).toHaveFocus();
  await expect.element(screen.getByTestId("review-selection-baseline")).toHaveTextContent("high");
  await trigger.click();
  await screen.getByRole("menuitem", { name: new RegExp(getMessages().commands.changeModel) }).click();
  await screen.getByRole("menuitem", { name: /长名称模型/ }).click();
  await expect.poll(menu).toBeNull();
  await expect.element(trigger).toHaveFocus();
  await expect.element(screen.getByTestId("review-selection-baseline")).toHaveTextContent(UI_REVIEW_MODELS[1].name);
  await trigger.click();
  await expect.poll(menu).not.toBeNull();
  await userEvent.keyboard("{ArrowDown}{Escape}");
  await expect.poll(menu).toBeNull();
  await expect.element(trigger).toHaveFocus();
  await trigger.click();
  await expect.poll(menu).not.toBeNull();
  await userEvent.keyboard("{ArrowDown}{Tab}");
  await expect.poll(menu).toBeNull();
  await expect.element(screen.getByRole("button", { name: "中文长文", exact: true })).toHaveFocus();
});

test("real CopyButton waits for controlled clipboard results with Toast and inline feedback", async () => {
  let resolve!: () => void;
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
  const screen = await render(<UiReviewPage />);
  await screen.getByRole("button", { name: "复制试件", exact: true }).click();
  expect(write).toHaveBeenLastCalledWith(UI_REVIEW_TEXT);
  expect(document.querySelector(".pwa-operation-notification")).toBeNull();
  expect(root().querySelector(".pwa-review-copy")!.getAttribute("aria-label")).toBe("复制试件");
  resolve();
  await expect.poll(() => document.querySelector(".pwa-operation-notification")?.textContent).toContain(getMessages().workspace.copied);
  await screen.getByRole("button", { name: "原候选", exact: true }).click();
  await expect.poll(() => document.querySelector(".pwa-operation-notification")).toBeNull();
  await screen.getByRole("button", { name: "代码片段", exact: true }).click();
  const copy = screen.getByRole("button", { name: "复制试件", exact: true });
  const before = copy.element().getBoundingClientRect();
  await copy.click();
  expect(write).toHaveBeenLastCalledWith(UI_REVIEW_CODE);
  expect(root().querySelector(".pwa-review-copy-controls [aria-live='polite']")?.textContent).toBe("");
  resolve();
  await expect.poll(() => root().querySelector(".pwa-review-copy .pwa-copy-icons")?.hasAttribute("data-copied")).toBe(true);
  await expect.element(copy).toBeVisible();
  const after = root().querySelector(".pwa-review-copy")!.getBoundingClientRect();
  expect(Math.round(after.left)).toBe(Math.round(before.left));
  expect(Math.round(after.width)).toBe(Math.round(before.width));
  expect(root().querySelector(".pwa-review-copy-controls [aria-live='polite']")?.textContent).toBe(getMessages().workspace.copied);
  expect(document.querySelector(".pwa-operation-notification")).toBeNull();
  write.mockRejectedValueOnce(new Error("clipboard unavailable"));
  await copy.click();
  await expect.poll(() => root().querySelector(".pwa-review-copy-controls [aria-live='polite']")?.textContent).toBe(getMessages().workspace.copyFailed);
  expect(copy.element().getAttribute("aria-label")).toBe("复制试件");
  expect(root().querySelector(".pwa-review-copy .pwa-copy-icons")?.hasAttribute("data-copied")).toBe(false);
  expect(document.querySelector(".pwa-operation-notification")).toBeNull();
});

test.each(["baseline", "candidate", "deepseek"] as const)("%s growing menu stays inside the viewport and outside clicks keep their focus", async (variant) => {
  await page.viewport(1280, 1040);
  setLanguagePreference("zh");
  const screen = await render(<UiReviewPage />);
  if (variant !== "baseline") await screen.getByRole("button", { name: VARIANT_LABELS[variant], exact: true }).click();
  const trigger = screen.getByRole("button", { name: "打开模型与思考菜单", exact: true });
  await trigger.click();
  await expect.poll(() => menu() && getComputedStyle(menu()!).opacity).toBe("1");
  await screen.getByRole("menuitem", { name: new RegExp(getMessages().commands.changeModel) }).click();
  await expect.poll(() => Math.round(menu()!.getBoundingClientRect().bottom)).toBeLessThanOrEqual(1040);
  expect(Math.round(menu()!.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
  const outside = screen.getByRole("button", { name: "浅色", exact: true });
  await outside.click();
  await expect.poll(menu).toBeNull();
  await expect.element(outside).toHaveFocus();
});

test("fine pointer uses compact one-line rows and preserves naturally tall model names", async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  const screen = await render(<UiReviewPage />);
  expect(matchMedia("(pointer: fine)").matches).toBe(true);
  await screen.getByRole("button", { name: "原候选", exact: true }).click();
  const trigger = screen.getByRole("button", { name: "打开模型与思考菜单", exact: true });
  await trigger.click();
  await screen.getByRole("menuitem", { name: new RegExp(getMessages().commands.thinkingLevel) }).click();
  const row = screen.getByRole("menuitem", { name: "high", exact: true }).element();
  expect(Math.round(row.getBoundingClientRect().height)).toBe(40);
  await userEvent.keyboard("{Escape}");
  await trigger.click();
  await screen.getByRole("menuitem", { name: new RegExp(getMessages().commands.changeModel) }).click();
  const longModel = screen.getByRole("menuitem", { name: /长名称模型/ }).element();
  expect(Math.round(longModel.getBoundingClientRect().height)).toBeGreaterThan(40);
  expect(longModel.scrollWidth).toBeLessThanOrEqual(longModel.clientWidth);
  await userEvent.keyboard("{Escape}");
  await expect.poll(menu).toBeNull();
});

test.each([320, 390, 1280])("fits %i px with scrollable content, reduced motion and coarse pointer targets", async (width) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const screen = await render(<UiReviewPage />);
  await expect.element(screen.getByTestId("review-motion")).toHaveTextContent("未启用");
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await screen.getByRole("button", { name: "原候选", exact: true }).click();
  await screen.getByRole("button", { name: "窄 · 320", exact: true }).click();
  await expect.element(screen.getByTestId("review-motion")).toHaveTextContent("已生效");
  const scroll = root().querySelector<HTMLElement>(".pwa-review-scroll")!;
  expect(Math.round(scroll.scrollWidth)).toBeLessThanOrEqual(Math.round(scroll.clientWidth));
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  expect(Math.round(root().querySelector(".pwa-review-specimen")!.getBoundingClientRect().width)).toBeLessThanOrEqual(320);
  expect(getComputedStyle(root()).getPropertyValue("--pwa-motion-shift").trim()).toBe("0");
  await screen.getByRole("button", { name: "打开模型与思考菜单", exact: true }).click();
  await screen.getByRole("menuitem", { name: new RegExp(getMessages().commands.thinkingLevel) }).click();
  expect(matchMedia("(any-pointer: coarse)").matches).toBe(true);
  for (const row of menu()!.querySelectorAll(".pwa-command-row, .pwa-command-back")) {
    expect(Math.round(row.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
  await userEvent.keyboard("{Escape}");
  await expect.poll(menu).toBeNull();
  // DS 候选在同一触控条件下不降级到密集行，并锁住菜单内部滚动不外溢。
  await screen.getByRole("button", { name: VARIANT_LABELS.deepseek, exact: true }).click();
  await screen.getByRole("button", { name: "打开模型与思考菜单", exact: true }).click();
  await screen.getByRole("menuitem", { name: new RegExp(getMessages().commands.thinkingLevel) }).click();
  expect(getComputedStyle(menu()!).overscrollBehavior).toContain("contain");
  for (const row of menu()!.querySelectorAll(".pwa-command-row, .pwa-command-back")) {
    expect(Math.round(row.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
  await userEvent.keyboard("{Escape}");
  await expect.poll(menu).toBeNull();
});

test("DS composer reads as a grounded surface and answers focus with a halo without moving content", async () => {
  const screen = await render(<UiReviewPage />);
  await screen.getByRole("button", { name: VARIANT_LABELS.deepseek, exact: true }).click();
  const card = composerCard();
  const footer = card.querySelector<HTMLElement>(".pwa-composer-footer")!;
  const input = screen.getByRole("textbox");
  const before = card.getBoundingClientRect();
  expect(getComputedStyle(card).borderRadius).toBe("14px");
  // 切换候选后的 120ms 颜色过渡需先走完，再比较静止态与聚焦态。
  await expect.poll(() => getComputedStyle(card).boxShadow).not.toBe("none");
  await expect.poll(() => getComputedStyle(card).boxShadow).not.toContain("3px");
  await expect.poll(() => getComputedStyle(footer).borderTopColor).toBe("rgba(0, 0, 0, 0)");
  const restingBorder = getComputedStyle(card).borderTopColor;
  await input.click();
  await expect.poll(() => getComputedStyle(card).boxShadow).toContain("3px");
  expect(getComputedStyle(card).borderTopColor).not.toBe(restingBorder);
  await expect.poll(() => getComputedStyle(footer).borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
  const after = card.getBoundingClientRect();
  expect([Math.round(after.width), Math.round(after.height)]).toEqual([Math.round(before.width), Math.round(before.height)]);
  // 深色主题按表面与轮廓分层，不靠投影加深层次。
  input.element().blur();
  await screen.getByRole("button", { name: "深色", exact: true }).click();
  await expect.poll(() => getComputedStyle(card).boxShadow).toBe("none");
});

test("DS fine-pointer menu is tighter and content-driven while long names still grow", async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  const screen = await render(<UiReviewPage />);
  expect(matchMedia("(pointer: fine)").matches).toBe(true);
  await screen.getByRole("button", { name: VARIANT_LABELS.deepseek, exact: true }).click();
  const trigger = screen.getByRole("button", { name: "打开模型与思考菜单", exact: true });
  await trigger.click();
  await screen.getByRole("menuitem", { name: new RegExp(getMessages().commands.thinkingLevel) }).click();
  const row = screen.getByRole("menuitem", { name: "high", exact: true }).element();
  expect(Math.round(row.getBoundingClientRect().height)).toBe(36);
  // 行内留白上下左右对称；相邻选项之间不插行间空隙，密度来自内容而不是统一最小高。
  expect([getComputedStyle(row).paddingTop, getComputedStyle(row).paddingLeft]).toEqual(["4px", "8px"]);
  const levels = [...menu()!.querySelectorAll(".pwa-command-row")].map((node) => node.getBoundingClientRect());
  expect(Math.round(levels[1].top - levels[0].bottom)).toBe(0);
  await userEvent.keyboard("{Escape}");
  await trigger.click();
  await screen.getByRole("menuitem", { name: new RegExp(getMessages().commands.changeModel) }).click();
  const menuBox = menu()!.getBoundingClientRect();
  expect(Math.round(menuBox.height)).toBeLessThanOrEqual(420);
  expect(Math.round(menuBox.height)).toBeGreaterThan(380);
  const longModel = screen.getByRole("menuitem", { name: /长名称模型/ }).element();
  expect(Math.round(longModel.getBoundingClientRect().height)).toBeGreaterThan(36);
  expect(longModel.scrollWidth).toBeLessThanOrEqual(longModel.clientWidth);
  await userEvent.keyboard("{Escape}");
  await expect.poll(menu).toBeNull();
});

test("DS copy feedback writes the result as text, keeps the button name and announces once", async () => {
  let resolve!: () => void;
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
  const screen = await render(<UiReviewPage />);
  await screen.getByRole("button", { name: VARIANT_LABELS.deepseek, exact: true }).click();
  const copy = screen.getByRole("button", { name: "复制试件", exact: true });
  const before = copy.element().getBoundingClientRect();
  const statusWidth = Math.round(copyStatus().getBoundingClientRect().width);
  await copy.click();
  expect(write).toHaveBeenLastCalledWith(UI_REVIEW_TEXT);
  // 剪贴板未完成前不显示任何结果，也不弹 Toast。
  expect(copyStatus().textContent).toBe("");
  expect(copyAnnouncement().textContent).toBe("");
  expect(document.querySelector(".pwa-operation-notification")).toBeNull();
  resolve();
  await expect.poll(() => copyStatus().textContent).toBe(getMessages().workspace.copied);
  expect(copyAnnouncement().textContent).toBe(getMessages().workspace.copied);
  expect(copy.element().getAttribute("aria-label")).toBe("复制试件");
  expect(Math.round(copyStatus().getBoundingClientRect().width)).toBe(statusWidth);
  const after = copy.element().getBoundingClientRect();
  expect([Math.round(after.left), Math.round(after.width)]).toEqual([Math.round(before.left), Math.round(before.width)]);
  expect(document.querySelector(".pwa-operation-notification")).toBeNull();
  write.mockRejectedValueOnce(new Error("clipboard unavailable"));
  await copy.click();
  await expect.poll(() => copyStatus().textContent).toBe(getMessages().workspace.copyFailed);
  expect(copyStatus().dataset.state).toBe("error");
  expect(copy.element().getAttribute("aria-label")).toBe("复制试件");
  expect(root().querySelector(".pwa-copy-inline-icons[data-copied]")).toBeNull();
  expect(document.querySelector(".pwa-operation-notification")).toBeNull();
});

const columns = () => [...root().querySelectorAll<HTMLElement>(".pwa-review-compare-head")];
const composerCards = () => [...root().querySelectorAll<HTMLElement>(".pwa-review-compare-cell .pwa-composer-card")];
const openMenus = () => [...document.querySelectorAll<HTMLElement>(".pwa-review-menu:not([inert])")];
/** 菜单项最小高度：当前版 44、原候选 40、DS 36（细指针）。 */
const minRowHeight = (menu: HTMLElement) => Math.min(...[...menu.querySelectorAll<HTMLElement>(".pwa-command-row, .pwa-command-back")]
  .map((row) => Math.round(row.getBoundingClientRect().height)));

test("side-by-side comparison shows the three real variants on one page with equal columns and shared content", async () => {
  const screen = await render(<UiReviewPage />);
  await screen.getByRole("button", { name: "横向对比", exact: true }).click();
  expect(root().dataset.layout).toBe("compare");
  expect(columns().map((column) => column.dataset.variant)).toEqual(["baseline", "candidate", "deepseek"]);
  const cards = composerCards();
  expect(cards).toHaveLength(3);
  const widths = cards.map((card) => Math.round(card.getBoundingClientRect().width));
  expect(widths[0]).toBeGreaterThan(200);
  expect(new Set(widths).size).toBe(1);
  // 三版同一页各自生效：圆角互不相同，说明样式作用域没有串列。
  expect(cards.map((card) => getComputedStyle(card).borderRadius)).toEqual(["12px", "16px", "14px"]);
  expect(root().querySelectorAll(".pwa-composer-input")).toHaveLength(3);
  const inputs = [...root().querySelectorAll<HTMLTextAreaElement>(".pwa-composer-input")];
  await userEvent.click(inputs[1]);
  await userEvent.keyboard("X");
  await expect.poll(() => inputs[0].value).toContain("X");
  expect(new Set(inputs.map((input) => input.value)).size).toBe(1);
  // 切回单栏后仍只有一份试件，且版本作用域回到根元素。
  await screen.getByRole("button", { name: "单栏切换", exact: true }).click();
  expect(root().dataset.variant).toBe("baseline");
  expect(root().querySelectorAll(".pwa-review-compare-cell")).toHaveLength(0);
  expect(columns()).toHaveLength(0);
  expect(root().querySelectorAll(".pwa-composer-input")).toHaveLength(1);
});

test("pinned comparison keeps the three menus open and shows each candidate density side by side", async () => {
  // 三份菜单同时展开需要足够高度，否则最下面一行会落在视口外。
  await page.viewport(1280, 1200);
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  const screen = await render(<UiReviewPage />);
  await screen.getByRole("button", { name: "横向对比", exact: true }).click();
  await screen.getByRole("button", { name: "三版菜单同时展开", exact: true }).click();
  await expect.poll(() => openMenus().length).toBe(3);
  // 根视图两行文案由内容决定高度；进入单行的思考级别列表才体现三版各自的密度。
  for (const menu of openMenus()) {
    await userEvent.click(menu.querySelector<HTMLElement>('.pwa-command-row[data-command-view="thinking"]')!);
  }
  await expect.poll(() => openMenus().length).toBe(3);
  expect(openMenus().map(minRowHeight).sort((left, right) => left - right)).toEqual([36, 40, 44]);
  // 固定展开期间点击外部不会关掉任何一份，便于同屏比较。
  await screen.getByRole("button", { name: "浅色", exact: true }).click();
  await expect.poll(() => openMenus().length).toBe(3);
  await screen.getByRole("button", { name: "三版菜单同时展开", exact: true }).click();
  await expect.poll(() => openMenus().length).toBe(0);
});

test("copy feedback stays independent per column while every version waits for the real clipboard", async () => {
  const resolves: (() => void)[] = [];
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(() => new Promise<void>((done) => { resolves.push(done); }));
  const screen = await render(<UiReviewPage />);
  await screen.getByRole("button", { name: "横向对比", exact: true }).click();
  const buttons = [...root().querySelectorAll<HTMLElement>(".pwa-review-copy")];
  expect(buttons).toHaveLength(3);
  for (const button of buttons) await userEvent.click(button);
  await expect.poll(() => resolves.length).toBe(3);
  // 三份剪贴板都未完成：没有任何一列提前确认成功。
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["复制试件", "复制试件", "复制试件"]);
  expect(root().querySelector(".pwa-copy-inline-status")!.textContent).toBe("");
  expect(document.querySelector(".pwa-operation-notification")).toBeNull();
  for (const resolve of resolves) resolve();
  await expect.poll(() => buttons[1].querySelector(".pwa-copy-icons")?.hasAttribute("data-copied")).toBe(true);
  expect(buttons[1].getAttribute("aria-label")).toBe("复制试件");
  expect(buttons[0].getAttribute("aria-label")).toBe(getMessages().workspace.copied);
  expect(buttons[2].getAttribute("aria-label")).toBe("复制试件");
  expect(root().querySelector(".pwa-copy-inline-status")!.textContent).toBe(getMessages().workspace.copied);
  expect(document.querySelectorAll(".pwa-operation-notification")).toHaveLength(1);
});
