import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { getLanguageState } from "@/lib/i18n/locale";
import { setLanguagePreference } from "@/lib/i18n";
import { en } from "@/lib/i18n/messages/en";
import type { PresentationEntry, ThinkingEntry, ToolEntry } from "@/lib/pwa/timeline-presentation";
import { ProcessGroup as ProcessGroupView } from "./process-group";
import { processGroups, withProcessExpansion, type ProcessExpansion, type ProcessGroup } from "./process-groups";
import { processGroupState, type ProcessGroupState } from "./process-group-state";
import { observeProcessEntries, timelineActivity } from "./timeline-activity";

// 隔离的合成展示数据，不连接真实会话，也不写入历史或运行状态。
const scope = { session_id: "process-fixture", leaf_id: "leaf", group_id: "run" };
const tool = (key: string, status?: "complete" | "error" | "interrupted", command = `pnpm ${key}`): ToolEntry => ({ kind: "tool", key, value: status === undefined ? {
  ...scope, protocol_version: 2, type: "timeline_partial", kind: "tool", partial_id: key, tool_call_id: key, tool: "bash", args: { command }, status: "running",
} : {
  ...scope, kind: "tool", event_id: key, timestamp: 1, tool_call_id: key, tool: "bash", args: { command }, truncated: false,
  ...(status === "error" ? { status, error: "failed" } : status === "interrupted" ? { status } : { status, result: "done" }),
} });
const thinking = (text = "**Reviewing Pi Reach**\nDetails.", streaming = true): ThinkingEntry => ({ kind: "thinking", key: "thought", groupId: "run", text, streaming });
type Source = {
  entries: readonly PresentationEntry[];
  live: boolean;
  running: boolean;
  ended: boolean;
  choices: ReadonlyMap<string, ProcessExpansion>;
};
type Snapshot = Source & {
  groups: readonly ProcessGroup[];
  observed: ReadonlyMap<string, number>;
  expanded: ReadonlyMap<string, boolean>;
  states: ReadonlyMap<string, ProcessGroupState>;
};
function project(previous: Snapshot | undefined, patch: Partial<Source>): Snapshot {
  const source: Source = { entries: [], live: true, running: true, ended: false, choices: new Map(), ...previous, ...patch };
  const groups = processGroups(source.entries, new Set(), previous?.groups);
  const observed = observeProcessEntries(source.entries, previous?.observed ?? new Map());
  const activity = timelineActivity(source.entries, source.live, source.running, () => source.ended);
  const states = new Map(groups.map(group => [group.key, processGroupState(group, {
    entries: source.entries, activity, observed, completion: source.ended ? { status: "complete", timestamp: 2 } : undefined,
    choices: source.choices, previousExpanded: previous?.expanded.get(group.key),
  })]));
  return { ...source, groups, observed, states, expanded: new Map([...states].map(([key, state]) => [key, state.expanded])) };
}

const language = getLanguageState().preference;
const scheme = document.documentElement.getAttribute("data-mantine-color-scheme");
afterEach(async () => {
  setLanguagePreference(language);
  if (scheme === null) document.documentElement.removeAttribute("data-mantine-color-scheme");
  else document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
  document.documentElement.style.removeProperty("--pwa-text-body");
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 900);
});

async function harness(options: Partial<Source> = {}) {
  setLanguagePreference("en");
  let update!: (patch: Partial<Source>) => void;
  let snapshot!: Snapshot;
  const read = vi.fn();
  const focused = vi.fn();
  const visible = vi.fn();
  function Harness() {
    const [source, setSource] = useState(() => project(undefined, { entries: [thinking(), tool("check")], ...options }));
    snapshot = source;
    update = patch => flushSync(() => setSource(previous => project(previous, patch)));
    const toggle = (key: string, expanded: boolean) => setSource(previous => {
      const group = previous.groups.find(candidate => candidate.key === key)!;
      return project(previous, { choices: withProcessExpansion(previous.choices, group.entries.map(entry => entry.key), expanded) });
    });
    return <div style={{ maxWidth: 720, width: "100%" }}>{source.groups.map(group => <ProcessGroupView key={group.key} group={group} state={source.states.get(group.key)!}
      onToggle={toggle} onRead={read} onFocusWithinChange={focused} onRunningToolsChange={visible} />)}</div>;
  }
  const screen = await renderPwa(<Harness />);
  const root = () => document.querySelector<HTMLElement>(".pwa-process-group")!;
  const head = () => root().querySelector<HTMLElement>(".pwa-process-head")!;
  return { screen, root, head, update, read, focused, visible, snapshot: () => snapshot };
}

async function finish(element: Element) {
  await Promise.allSettled(element.getAnimations({ subtree: true }).filter(animation =>
    Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)).map(animation => animation.finished));
}
const rect = (node: Element) => node.getBoundingClientRect();
const round = (value: number) => Math.round(value);

test("running groups mount immediately with one viewport identity, real rows and no entry motion", async () => {
  const view = await harness();
  expect(view.head().getAttribute("aria-expanded")).toBe("true");
  const collapse = view.root().querySelector<HTMLElement>(".pwa-collapse")!;
  expect(getComputedStyle(collapse).opacity).toBe("1");
  expect(collapse.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity))).toHaveLength(0);
  const key = view.snapshot().groups[0]!.key;
  expect(view.root().dataset.timelineKey).toBe(key);
  expect(view.root().dataset.viewportRow).toBe(key);
  expect(view.root().querySelectorAll("[data-viewport-row]")).toHaveLength(0);
  expect(view.root().querySelectorAll(".pwa-process-entry")).toHaveLength(2);
  expect(view.root().querySelectorAll(".pwa-thinking-process-row .pwa-text-plain, .pwa-process-entry pre")).toHaveLength(0);
});

test("collapsed header switches immediately to the latest still-running item and never replays finished calls", async () => {
  const view = await harness({ entries: [tool("first"), tool("second")] });
  await page.elementLocator(view.head()).click();
  await finish(view.root());
  expect(view.head().textContent).toContain("pnpm second");
  expect(view.head().textContent).not.toContain("pnpm first");
  expect(view.head().textContent).toContain("+1");
  await expect.element(page.getByRole("status", { name: "1 other running tools" })).toBeVisible();
  view.update({ entries: [tool("first"), tool("second", "complete")] });
  expect(view.head().textContent).toContain("pnpm first");
  expect(view.head().textContent).not.toContain("pnpm second");
  expect(view.head().textContent).not.toContain("+0");
  // 组头不再承载 Working：全部完成后显示分类摘要，Working 只在时间线末尾兜底。
  view.update({ entries: [tool("first", "complete"), tool("second", "complete")] });
  expect(view.head().textContent).not.toContain(en.timeline.working);
  expect(view.head().textContent).not.toMatch(/pnpm (first|second)/);
});

test("a current Thinking header counts every parallel running tool and does not restart title motion", async () => {
  const view = await harness({ entries: [tool("first"), tool("second"), thinking()] });
  expect(view.head().textContent).not.toContain("+2");
  await page.elementLocator(view.head()).click();
  await finish(view.root());
  expect(view.head().textContent).toContain("Reviewing Pi Reach");
  expect(view.head().textContent).toContain("+2");
  await expect.element(page.getByRole("status", { name: "2 other running tools" })).toBeVisible();
  expect(view.head().getAnimations({ subtree: true }).some(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity))).toBe(false);
  view.update({ entries: [tool("first"), tool("second"), thinking("**A new title**\nMore.")] });
  expect(view.head().textContent).toContain("A new title");
  expect(view.head().getAnimations({ subtree: true }).some(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity))).toBe(false);
});

test("Thinking and tool rows retain their full-row reader trigger and empty traces cannot open a reader", async () => {
  const view = await harness();
  const row = view.root().querySelector<HTMLElement>(".pwa-thinking-process-row")!;
  const button = row.querySelector<HTMLButtonElement>("button")!;
  await page.elementLocator(button).click();
  expect(view.read).toHaveBeenLastCalledWith(view.snapshot().groups[0]!.entries[0], button);
  expect(button.getAttribute("aria-haspopup")).toBe("dialog");
  const toolButton = view.root().querySelector<HTMLButtonElement>(".pwa-tool-card button")!;
  await page.elementLocator(toolButton).click();
  expect(view.read).toHaveBeenLastCalledWith(view.snapshot().groups[0]!.entries[1], toolButton);
  view.update({ entries: [thinking("", false)], live: false, running: false, ended: true });
  expect(view.root().querySelectorAll("button")).toHaveLength(0);
  expect(view.root().querySelectorAll(".pwa-collapse, .pwa-timeline-chevron")).toHaveLength(0);
  expect(view.root().textContent).toBe(en.timeline.thinkingTrace);
  expect(round(rect(view.root().querySelector(".pwa-process-status-slot")!).width)).toBe(16);
});

test("manual expansion remains on formal completion and disconnect preserves choices while stopping spinners", async () => {
  const view = await harness({ entries: [tool("first")] });
  await page.elementLocator(view.head()).click();
  await finish(view.root());
  await page.elementLocator(view.head()).click();
  await finish(view.root());
  const choices = view.snapshot().choices;
  view.update({ live: false });
  expect(view.snapshot().choices).toBe(choices);
  expect(view.head().getAttribute("aria-expanded")).toBe("true");
  expect(view.root().querySelectorAll(".pwa-tool-spinner")).toHaveLength(0);
  view.update({ entries: [tool("first", "complete")], ended: true });
  expect(view.head().getAttribute("aria-expanded")).toBe("true");
  expect(view.snapshot().choices).toBe(choices);
});

test("a running header preserves an accessible failure badge even when the current call replaces its summary", async () => {
  const view = await harness({ entries: [tool("failed", "error"), tool("current")] });
  await page.elementLocator(view.head()).click();
  await finish(view.root());
  expect(view.head().textContent).toContain("pnpm current");
  const badge = view.head().querySelector<HTMLElement>(".pwa-process-alert")!;
  expect(badge).not.toBeNull();
  expect(badge.getAttribute("aria-label")).toContain(en.tools.groupFailed(1));
  expect(round(rect(badge).width)).toBeGreaterThanOrEqual(16);
});

test("focus protection reports only detail focus and releases when the focused member disappears", async () => {
  const view = await harness();
  view.head().focus();
  expect(view.focused.mock.calls.some(([, focused]) => focused)).toBe(false);
  view.root().querySelector<HTMLButtonElement>(".pwa-thinking-process-row button")!.focus();
  await expect.poll(() => view.focused.mock.calls.at(-1)?.[1]).toBe(true);
  view.update({ entries: [tool("check")] });
  await expect.poll(() => view.focused.mock.calls.at(-1)?.[1]).toBe(false);
});

const sizes = [320, 402, 1280].flatMap(width => ["light", "dark"].map(theme => ({ width, theme })));
test.each(sizes)("short connectors, fixed left status slots and single-line rows at $width/$theme", async ({ width, theme }) => {
  await page.viewport(width, 900);
  const long = "pwa/src/components/pwa/".repeat(8);
  const view = await harness({ entries: [thinking("**A long Pi Reach title repeated repeatedly**\nDetails.", false), tool("read", "complete", long), tool("running", undefined, long)] });
  document.documentElement.setAttribute("data-mantine-color-scheme", theme);
  const entries = [...view.root().querySelectorAll<HTMLElement>(".pwa-process-entry")];
  expect(entries).toHaveLength(3);
  const slots = entries.map(entry => entry.querySelector<HTMLElement>(".pwa-process-status-slot, .pwa-tool-status")!);
  for (const [index, entry] of entries.entries()) {
    const control = entry.querySelector<HTMLElement>("button")!;
    expect(round(rect(control).height)).toBeGreaterThanOrEqual(44);
    expect(round(rect(control).width)).toBe(round(rect(entry).width));
    expect(round(rect(slots[index]!).width)).toBe(16);
    expect(round(rect(slots[index]!).left)).toBe(round(rect(slots[0]!).left));
    const line = getComputedStyle(entry, "::before");
    if (index === 0) expect(line.content).toMatch(/^(none|normal)$/);
    else {
      expect(line.content).not.toMatch(/^(none|normal)$/);
      expect(round(Number.parseFloat(line.height))).toBe(16);
      expect(round(Number.parseFloat(line.width))).toBe(1);
      expect(line.pointerEvents).toBe("none");
    }
    expect(getComputedStyle(entry, "::after").content).toMatch(/^(none|normal)$/);
  }
  const heading = view.root().querySelector<HTMLElement>(".pwa-process-thinking-heading")!;
  expect(getComputedStyle(heading).fontStyle).toBe("italic");
  expect(getComputedStyle(heading).fontSize).toBe(getComputedStyle(view.head()).fontSize);
  const detail = view.root().querySelector<HTMLElement>(".pwa-tool-action-copy > span")!;
  expect(getComputedStyle(detail).textOverflow).toBe("ellipsis");
  expect(getComputedStyle(detail).whiteSpace).toBe("nowrap");
  expect(view.root().scrollWidth).toBeLessThanOrEqual(view.root().clientWidth);
  expect(round(rect(view.root()).right)).toBeLessThanOrEqual(width);
  const color = getComputedStyle(heading).color;
  document.documentElement.setAttribute("data-mantine-color-scheme", theme === "light" ? "dark" : "light");
  expect(getComputedStyle(heading).color).not.toBe(color);
  document.documentElement.setAttribute("data-mantine-color-scheme", theme);
  if (width === 402) {
    await cdp().send("Input.dispatchMouseEvent", { type: "mouseMoved", x: width - 1, y: 899 });
    await page.screenshot({ element: view.root(), path: `../../../../.pi/tmp/thinking-tool-p3-${theme}.png` });
  }
});

test("large text and reduced motion retain icon alignment without geometric title transitions", async () => {
  await page.viewport(320, 900);
  document.documentElement.style.setProperty("--pwa-text-body", "24px");
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const view = await harness({ entries: [thinking()] });
  const title = () => view.root().querySelector<HTMLElement>(".pwa-process-thinking-heading")!;
  const left = round(rect(title()).left);
  const slot = view.root().querySelector<HTMLElement>(".pwa-thinking-process-row .pwa-process-status-slot")!;
  expect(round(rect(slot).width)).toBe(16);
  expect(getComputedStyle(title()).fontSize).toBe("24px");
  view.update({ entries: [thinking("**Finished title**\nDetails.", false)], ended: true, choices: withProcessExpansion(new Map(), ["thought"], true) });
  expect(round(rect(title()).left)).toBe(left);
  expect(round(rect(slot).width)).toBe(16);
  expect(title().getAnimations({ subtree: true })).toHaveLength(0);
  expect(getComputedStyle(title()).transitionProperty).not.toMatch(/width|transform/);
  expect(view.root().scrollWidth).toBeLessThanOrEqual(view.root().clientWidth);
});
