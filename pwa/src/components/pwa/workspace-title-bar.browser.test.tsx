import { afterEach, beforeEach, expect, test } from "vitest";
import { cleanup } from "vitest-browser-react";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { WorkspaceTitleBar } from "./workspace-title-bar";

const LONG_TITLE = `Release check ${"with a very long conversation title ".repeat(10)}`;
const LONG_PROJECT = `pi-reach-${"long-project-directory-name-".repeat(10)}`;

function renderBar(props: Partial<Parameters<typeof WorkspaceTitleBar>[0]> = {}) {
  return renderPwa(<WorkspaceTitleBar title="Release check" showTitle prefix="pi-reach-desk" navigationExpanded={false} onOpenNavigation={() => {}} onRefresh={() => {}} {...props} />);
}

function titleBar(): HTMLElement {
  return document.querySelector<HTMLElement>(".pwa-title-bar")!;
}

function centerY(rect: DOMRect): number {
  return Math.round(rect.top + rect.height / 2);
}

beforeEach(() => {
  // 组件独立渲染时补齐工作区列提供的主区内边距变量，桌面标题区按真实布局取值。
  document.documentElement.style.setProperty("--pwa-main-safe-top", "0px");
  document.documentElement.style.setProperty("--pwa-main-safe-left", "0px");
  document.documentElement.style.setProperty("--pwa-main-safe-right", "0px");
  document.documentElement.style.setProperty("--pwa-main-inset-start", "20px");
});

afterEach(async () => {
  await cleanup();
  for (const property of ["--pwa-main-safe-top", "--pwa-main-safe-left", "--pwa-main-safe-right", "--pwa-main-inset-start", "--pwa-safe-top"]) {
    document.documentElement.style.removeProperty(property);
  }
  delete document.documentElement.dataset.pwaTextSize;
  await page.viewport(1280, 900);
});

test("shows only the session name in h1 and the project as a second line without a separator", async () => {
  await page.viewport(1280, 844);
  const screen = await renderBar();
  const heading = screen.getByRole("heading", { level: 1, name: "Release check" });
  await expect.element(heading).toBeVisible();
  const name = heading.element() as HTMLElement;
  const project = document.querySelector<HTMLElement>(".pwa-title-bar-project")!;

  // 会话名是唯一的一级标题，title 只保留会话名；项目名独立成行并保留完整 title。
  expect(document.querySelectorAll("h1")).toHaveLength(1);
  expect(name.getAttribute("title")).toBe("Release check");
  expect(name.textContent).toBe("Release check");
  expect(project.textContent).toBe("pi-reach-desk");
  expect(project.getAttribute("title")).toBe("pi-reach-desk");
  expect(name.querySelector(".pwa-title-bar-project")).toBeNull();

  // 字号、字重与颜色沿用标题／说明 token。
  expect(getComputedStyle(name).fontSize).toBe("18px");
  expect(getComputedStyle(name).fontWeight).toBe("600");
  expect(getComputedStyle(name).lineHeight).toBe("25.2px");
  expect(getComputedStyle(project).fontSize).toBe("13px");
  expect(getComputedStyle(project).fontWeight).toBe("400");
  expect(getComputedStyle(project).color).not.toBe(getComputedStyle(name).color);

  // 两行左对齐、间隔 2px；项目行紧接在会话名之后。
  const nameBox = name.getBoundingClientRect();
  const projectBox = project.getBoundingClientRect();
  expect(name.nextElementSibling).toBe(project);
  expect(Math.round(projectBox.left)).toBe(Math.round(nameBox.left));
  expect(Math.round(projectBox.top - nameBox.bottom)).toBe(2);

  // 标准档桌面标题区为 64，首行中心与右侧操作都落在共享 48 顶栏带的中央。
  const barBox = titleBar().getBoundingClientRect();
  const actions = document.querySelector<HTMLElement>(".pwa-title-bar-actions")!;
  const actionsBox = actions.getBoundingClientRect();
  expect(Math.round(barBox.height)).toBe(64);
  expect(Math.abs(centerY(nameBox) - Math.round(barBox.top + 24))).toBeLessThanOrEqual(1);
  expect(Math.abs(centerY(actionsBox) - Math.round(barBox.top + 24))).toBeLessThanOrEqual(1);
  expect(Math.round(actionsBox.top)).toBe(Math.round(barBox.top));
  expect(Math.round(nameBox.right)).toBeLessThanOrEqual(Math.round(actionsBox.left));

  // 刷新仍是 44px 命中区。
  const refresh = document.querySelector<HTMLElement>(".pwa-title-bar-refresh")!.getBoundingClientRect();
  expect([Math.round(refresh.width), Math.round(refresh.height)]).toEqual([44, 44]);
});

test("ellipsizes both lines at the 768px desktop edge without pushing the actions", async () => {
  await page.viewport(768, 900);
  const screen = await renderBar({ title: LONG_TITLE, prefix: LONG_PROJECT });
  await expect.element(screen.getByRole("heading", { level: 1 })).toBeVisible();
  const name = document.querySelector<HTMLElement>(".pwa-title-bar-name")!;
  const project = document.querySelector<HTMLElement>(".pwa-title-bar-project")!;
  const actions = document.querySelector<HTMLElement>(".pwa-title-bar-actions")!;

  expect(Math.round(titleBar().getBoundingClientRect().height)).toBe(64);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(768);
  // 两行各自单行省略，标题区收缩但右侧操作不被挤压。
  for (const line of [name, project]) {
    expect(getComputedStyle(line).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(line).textOverflow).toBe("ellipsis");
    expect(line.scrollWidth).toBeGreaterThan(line.clientWidth);
  }
  expect(Math.round(project.getBoundingClientRect().left)).toBe(Math.round(name.getBoundingClientRect().left));
  expect(Math.round(name.getBoundingClientRect().right)).toBeLessThanOrEqual(Math.round(actions.getBoundingClientRect().left));
  expect(Math.round(actions.getBoundingClientRect().right)).toBeLessThanOrEqual(768 - 8);
});

test("keeps the default 64px title area without a project and without a session", async () => {
  await page.viewport(1280, 844);
  const withProject = await renderBar();
  await expect.element(withProject.getByRole("heading", { level: 1 })).toBeVisible();
  expect(Math.round(titleBar().getBoundingClientRect().height)).toBe(64);
  await withProject.unmount();

  const withoutProject = await renderBar({ prefix: null });
  await expect.element(withoutProject.getByRole("heading", { level: 1 })).toBeVisible();
  expect(document.querySelector(".pwa-title-bar-project")).toBeNull();
  expect(Math.round(titleBar().getBoundingClientRect().height)).toBe(64);
  await withoutProject.unmount();

  const withoutSession = await renderBar({ showTitle: false });
  // 移动导航入口始终在 DOM 中（桌面隐藏），但会话名与项目两行都不渲染。
  expect(document.querySelector(".pwa-session-trigger")).not.toBeNull();
  expect(document.querySelector("h1")).toBeNull();
  expect(document.querySelector(".pwa-title-bar-project")).toBeNull();
  expect(Math.round(titleBar().getBoundingClientRect().height)).toBe(64);
  await withoutSession.unmount();
});

test("lets enlarged text grow the title area without clipping and keeps the first row band", async () => {
  await page.viewport(1280, 844);
  await renderBar();
  const name = document.querySelector<HTMLElement>(".pwa-title-bar-name")!;
  const project = document.querySelector<HTMLElement>(".pwa-title-bar-project")!;
  document.documentElement.dataset.pwaTextSize = "xlarge";
  await expect.poll(() => getComputedStyle(name).fontSize).toBe("22px");
  await expect.poll(() => getComputedStyle(project).fontSize).toBe("15px");

  const barBox = titleBar().getBoundingClientRect();
  const nameBox = name.getBoundingClientRect();
  const projectBox = project.getBoundingClientRect();
  const actionsBox = document.querySelector<HTMLElement>(".pwa-title-bar-actions")!.getBoundingClientRect();
  const lineHeight = Number.parseFloat(getComputedStyle(name).lineHeight);
  // 大字号时标题区自然增高，两行仍完整可见，不被 64 最小高裁切。
  expect(Math.round(barBox.height)).toBeGreaterThanOrEqual(64);
  expect(Math.round(barBox.height)).toBeLessThan(72);
  expect(Math.round(nameBox.height)).toBeGreaterThanOrEqual(Math.round(lineHeight));
  expect(Math.round(projectBox.bottom)).toBeLessThanOrEqual(Math.round(barBox.bottom - 6));
  expect(Math.round(projectBox.top - nameBox.bottom)).toBe(2);
  // 首行中心与右侧操作仍按 48 顶栏带对齐。
  expect(Math.abs(centerY(nameBox) - Math.round(barBox.top + 24))).toBeLessThanOrEqual(1);
  expect(Math.abs(centerY(actionsBox) - Math.round(barBox.top + 24))).toBeLessThanOrEqual(1);
});

test("keeps the mobile title bar at 48 plus safe top with a single navigation entry", async () => {
  await page.viewport(390, 844);
  document.documentElement.style.setProperty("--pwa-safe-top", "24px");
  const screen = await renderBar({ title: LONG_TITLE });
  const trigger = screen.getByRole("button", { name: "Open navigation" });
  await expect.element(trigger).toBeVisible();

  const barBox = titleBar().getBoundingClientRect();
  expect(Math.round(barBox.height)).toBe(48 + 24);
  // 项目行随桌面标题区一起隐藏，只剩单行导航入口，刷新也不显示。
  expect(getComputedStyle(document.querySelector<HTMLElement>(".pwa-title-bar-heading")!).display).toBe("none");
  expect(Math.round(document.querySelector<HTMLElement>(".pwa-title-bar-project")!.getBoundingClientRect().height)).toBe(0);
  expect(getComputedStyle(document.querySelector<HTMLElement>(".pwa-title-bar-refresh")!).display).toBe("none");
  expect(trigger.element().getAttribute("title")).toBe(LONG_TITLE);
  expect(document.querySelector<HTMLElement>(".pwa-session-trigger-title")!.textContent).toBe(LONG_TITLE);
  const triggerBox = trigger.element().getBoundingClientRect();
  expect(Math.round(triggerBox.height)).toBe(44);
  const icon = document.querySelector<HTMLElement>(".pwa-session-trigger-icon")!.getBoundingClientRect();
  expect(Math.abs(centerY(icon) - 48)).toBeLessThanOrEqual(1);
});
