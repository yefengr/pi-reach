import { afterEach, expect, test } from "vitest";
import { cleanup } from "vitest-browser-react";
import { renderPwa } from "@/test/browser/render";
import type { SessionStatus } from "@pi-reach/protocol/session";
import type { SessionStatusView } from "@/lib/pwa/session-status";
import { SessionStatusContent } from "./session-status";

type Extension = SessionStatus["extensions"][number];

const view = (extensions: Extension[] = [], level: "normal" | "high" = "normal"): SessionStatusView => ({ kind: "ready", status: {
  context: { tokens: level === "high" ? 156_000 : 84_000, window: 200_000, auto_compact: true, level },
  usage: { input: 1_200_000, output: 48_000, cache_read: 840_000, cache_write: 120_000, cost: 1.284, cache_hit_rate_session: 87.5, cache_hit_rate_latest: 92.4 },
  branch: "bugfix/261117-mobile-navigation-focus", extensions,
} });
const base = { title: "修复触屏导航焦点圈并恢复键盘焦点提示", deviceName: "MacBook Pro", cwd: "/Users/yefeng/code/pi-reach" };
const rect = (element: Element) => element.getBoundingClientRect();
const mobileRow = (text: string) => [...document.querySelectorAll<HTMLElement>(".pwa-session-status-content[data-mobile] .pwa-session-status-row")].find(row => row.textContent?.includes(text))!;

afterEach(cleanup);

test("desktop card has no block headings and reads as one flow with hairline separators", async () => {
  const screen = await renderPwa(<SessionStatusContent {...base} view={view([
    { key: "quota", label: "Quota", text: "82% used", tone: "warning", section: "usage" },
    { key: "ci", label: "CI", text: "Checks passed", section: "session" },
    { key: "todo", label: "Todo", text: "3 items" },
  ])} />);
  expect(document.querySelector(".pwa-session-status-content h2, .pwa-session-status-content h3")).toBeNull();
  await expect.element(screen.getByText("Context")).toBeVisible();
  const blocks = [...document.querySelectorAll<HTMLElement>(".pwa-session-status-block")];
  expect(blocks.length).toBe(4);
  expect(parseFloat(getComputedStyle(blocks[1]).borderTopWidth)).toBeGreaterThan(0);
  const contextRow = document.querySelector<HTMLElement>(".pwa-session-status-context-row")!;
  expect(Math.round(rect(contextRow.querySelector(".pwa-session-status-context-key")!).left)).toBe(Math.round(rect(contextRow).left));
  expect(document.querySelector(".pwa-session-status-level")).toBeNull();
  const percent = contextRow.querySelector(".pwa-session-status-percent")!;
  const number = document.createRange();
  number.selectNode(percent.lastChild!);
  expect(Math.round(number.getBoundingClientRect().right)).toBe(Math.round(rect(contextRow).right));
  const meta = contextRow.querySelector(".pwa-session-status-meta")!;
  expect(getComputedStyle(meta).textAlign).toBe("start");
  const branch = document.querySelector<HTMLElement>(".pwa-session-status-branch-row")!;
  expect(branch.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(branch.querySelector(".pwa-sr-only")?.textContent).toBe("Branch");
});

test("context reminder uses the washed pill and only appears above the threshold", async () => {
  const screen = await renderPwa(<SessionStatusContent {...base} view={view([], "high")} />);
  await expect.element(screen.getByText("High")).toBeVisible();
  const tag = document.querySelector<HTMLElement>(".pwa-session-status-level")!;
  expect(tag.dataset.level).toBe("high");
  const probe = document.createElement("span");
  probe.style.background = "var(--pwa-running-wash)";
  tag.parentElement!.append(probe);
  expect(getComputedStyle(tag).backgroundColor).toBe(getComputedStyle(probe).backgroundColor);
  probe.remove();
});

test("mobile drawer groups keep 44px rows with inset separators and a right-aligned occupancy line", async () => {
  await renderPwa(<SessionStatusContent {...base} view={view()} mobile />);
  await expect.poll(() => Boolean(document.querySelector(".pwa-session-status-context-row"))).toBe(true);
  const contextRow = document.querySelector<HTMLElement>(".pwa-session-status-context-row")!;
  const percent = contextRow.querySelector<HTMLElement>(".pwa-session-status-percent")!;
  expect(rect(contextRow).height).toBeGreaterThanOrEqual(43.5);
  expect(Math.round(rect(percent).right)).toBe(Math.round(rect(contextRow).right - 16));
  expect(Math.round(rect(contextRow.querySelector(".pwa-session-status-context-key")!).left)).toBe(Math.round(rect(contextRow).left + 16));
  const usageRow = [...document.querySelectorAll<HTMLElement>(".pwa-session-status-content[data-mobile] .pwa-session-status-row")].find(row => row.textContent?.includes("Output"))!;
  expect(Math.round(rect(usageRow.querySelector("dd")!).right)).toBe(Math.round(rect(usageRow).right - 16));
  const separator = getComputedStyle(usageRow, "::before");
  expect(parseFloat(separator.height)).toBeGreaterThan(0);
  expect(separator.left).toBe("16px");
});

test("mobile session block shows a bold wrapping name, muted device line and a single-line short path", async () => {
  await renderPwa(<SessionStatusContent {...base} title={`${base.title}，并确认移动端长标题完整换行显示`} view={view()} mobile />);
  await expect.poll(() => Boolean(document.querySelector(".pwa-session-status-name"))).toBe(true);
  const name = document.querySelector<HTMLElement>(".pwa-session-status-name")!;
  const device = name.parentElement!.querySelector<HTMLElement>(".pwa-session-status-meta")!;
  expect(getComputedStyle(name).fontWeight).toBe("600");
  expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
  expect(getComputedStyle(name).whiteSpace).toBe("normal");
  expect(device.textContent).toBe("MacBook Pro");
  expect(parseFloat(getComputedStyle(device).fontSize)).toBeLessThan(parseFloat(getComputedStyle(name).fontSize));
  const path = document.querySelector<HTMLTextAreaElement>(".pwa-session-status-path textarea")!;
  expect(path.rows).toBe(1);
  expect(rect(path).height).toBeLessThan(30);
});

test("a long working directory wraps inside the one-row field instead of guessed blank rows", async () => {
  await renderPwa(<div data-stage style={{ width: "320px" }}><SessionStatusContent {...base} cwd="/Users/yefeng/code/pi-reach/pwa/src/components/pwa" view={view()} mobile /></div>);
  await expect.poll(() => Boolean(document.querySelector(".pwa-session-status-path textarea"))).toBe(true);
  const path = document.querySelector<HTMLTextAreaElement>(".pwa-session-status-path textarea")!;
  expect(path.rows).toBe(1);
  expect(rect(path).height).toBeGreaterThan(30);
  expect(getComputedStyle(path).overflowWrap).toBe("anywhere");
});

test("mobile extension values share the row when they fit and move whole to a left-aligned second line when they do not", async () => {
  await renderPwa(<div data-stage style={{ width: "390px" }}>
    <SessionStatusContent {...base} mobile view={view([
      { key: "short", label: "Short", text: "OK" },
      { key: "long", label: "Long", text: "Checks passing on the release branch" },
    ])} />
  </div>);
  await expect.poll(() => Boolean(document.querySelector("[data-stage] .pwa-session-status-content"))).toBe(true);
  const stage = document.querySelector<HTMLElement>("[data-stage]")!;
  const longValue = mobileRow("Checks passing on the release branch").querySelector("dd")!;
  const longLabel = mobileRow("Checks passing on the release branch").querySelector("dt")!;
  expect(Math.round(rect(longValue).top)).toBe(Math.round(rect(longLabel).top));
  expect(Math.round(rect(longValue).right)).toBe(Math.round(rect(mobileRow("Checks passing on the release branch")).right - 16));
  stage.style.width = "200px";
  await expect.poll(() => Math.round(rect(longValue).top) > Math.round(rect(longLabel).top)).toBe(true);
  expect(Math.round(rect(longValue).left)).toBe(Math.round(rect(longLabel).left));
  const shortValue = mobileRow("Short").querySelector("dd")!;
  expect(Math.round(rect(shortValue).top)).toBe(Math.round(rect(mobileRow("Short").querySelector("dt")!).top));
  expect(Math.round(rect(shortValue).right)).toBe(Math.round(rect(mobileRow("Short")).right - 16));
  expect(shortValue.textContent).toBe("OK");
});
