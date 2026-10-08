import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import { cdp, page } from "vitest/browser";
import { Modal } from "@mantine/core";
import type { PublishedFileDescriptor } from "@pi-reach/protocol/session";
import { renderPwa } from "@/test/browser/render";
import { enableTouch, resetTouch, touch, type TouchPoint } from "@/test/browser/swipe";
import { PublishedFileReader } from "./published-file-reader";
import { PublishedFilesProvider, type PublishedFilesView, type PublishedFileViewState } from "./published-files-context";
import { ToolReader } from "./tool-reader";
import type { ToolValue } from "./tool-presentation";

const longText = Array.from({ length: 60 }, (_, index) => `Reading line ${index}: content for the drag tests.`).join("\n");
const toolValue: ToolValue = { event_id: "tool-event", session_id: "session", leaf_id: "leaf", group_id: "group", timestamp: 10, kind: "tool", tool_call_id: "read", tool: "read", args: { path: "notes.txt" }, status: "complete", truncated: false, result: longText };
const descriptor: PublishedFileDescriptor = { publication_id: "drag-file", file_name: "notes.txt", mime_type: "text/plain", byte_length: 20, tool_call_id: "publish" };
const fileState: PublishedFileViewState = { phase: "ready", receivedBytes: longText.length, preview: { kind: "text" }, text: longText };
const fileView: PublishedFilesView = { scopeToken: {}, canFetch: true, active: false, getState: () => fileState, open: vi.fn().mockResolvedValue(undefined), cancel: vi.fn(), pin: vi.fn(), unpin: vi.fn(), onReadingChange: vi.fn() };

type Kind = "tool" | "file";
const SURFACE: Record<Kind, string> = { tool: ".pwa-tool-reader", file: ".pwa-file-reader" };
const HISTORY_KEY: Record<Kind, string> = { tool: "piReachToolReader", file: "piReachFileReader" };
const DOWN_X = 100;
const LOCK_STEP = 12;

let mounted: Awaited<ReturnType<typeof renderPwa>> | undefined;
let modal: (opened: boolean) => void;
let reopen: () => void;
let close: Mock<() => void>;

const element = (selector: string) => document.querySelector<HTMLElement>(selector)!;
const surfaceOf = (kind: Kind) => element(SURFACE[kind]);
const offsetOf = (kind: Kind) => Math.round(surfaceOf(kind).getBoundingClientRect().left);
const history = (kind: Kind) => window.history.state?.[HISTORY_KEY[kind]];

function TopModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return <Modal opened={opened} onClose={onClose} title="Top confirmation" portalProps={{ target: ".pwa-root" }}><button>Confirm</button></Modal>;
}
function Harness({ kind }: { kind: Kind }) {
  const [opened, setOpened] = useState(true);
  const [top, setTop] = useState(false);
  useLayoutEffect(() => {
    modal = (value) => flushSync(() => setTop(value));
    reopen = () => flushSync(() => setOpened(true));
  }, []);
  const onClose = () => { close(); setOpened(false); };
  return <>
    {kind === "tool"
      ? <ToolReader value={toolValue} opened={opened} onClose={onClose} />
      : <PublishedFilesProvider value={fileView}><PublishedFileReader file={descriptor} opened={opened} onClose={onClose} onExitTransitionEnd={() => {}} /></PublishedFilesProvider>}
    <TopModal opened={top} onClose={() => setTop(false)} />
  </>;
}
async function open(kind: Kind) {
  close = vi.fn();
  mounted = await renderPwa(<Harness kind={kind} />);
  await expect.poll(() => history(kind)).toBeTruthy();
  await expect.poll(() => Math.round(surfaceOf(kind).getBoundingClientRect().right)).toBe(window.innerWidth);
  const origin: TouchPoint = { x: DOWN_X, y: 500, id: 1 };
  return { origin, kind };
}
/** CDP 触摸事件与渲染帧异步对齐；等两帧后再断言位置，避免读到上一步。 */
const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function moveTouch(origin: TouchPoint, dx: number) {
  await touch("touchMove", [{ ...origin, x: origin.x + dx }]);
  await frames();
}
/** 先走过方向锁定帧，再分步移动到 dx；不松手。 */
async function dragTo(origin: TouchPoint, dx: number) {
  await touch("touchStart", [origin]);
  await moveTouch(origin, LOCK_STEP);
  for (let step = 1; step <= 4; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await moveTouch(origin, LOCK_STEP + (dx - LOCK_STEP) * step / 4);
  }
}
const release = () => touch("touchEnd", []);
async function closed(kind: Kind) {
  await expect.poll(() => document.querySelector(SURFACE[kind])).toBeNull();
  await expect.poll(() => history(kind)).toBeUndefined();
  expect(close).toHaveBeenCalledOnce();
}

const setReducedMotion = (reduce: boolean) => cdp().send("Emulation.setEmulatedMedia", { features: reduce ? [{ name: "prefers-reduced-motion", value: "reduce" }] : [] });

beforeEach(async () => {
  window.history.replaceState(null, "", "/app");
  await page.viewport(390, 844);
  await enableTouch();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await setReducedMotion(false);
  await resetTouch();
  await mounted?.unmount();
  mounted = undefined;
  await expect.poll(() => window.history.state?.piReachToolReader ?? window.history.state?.piReachFileReader).toBeUndefined();
  window.history.replaceState(null, "", "/app");
  await page.viewport(1280, 900);
});

test.each(["tool", "file"] as const)("%s reader follows the finger from the lock frame and dims the scrim", async (kind) => {
  const { origin } = await open(kind);
  await dragTo(origin, 112);
  // 面板位移 = 手指位移 − 方向锁定那一帧的位移，没有约 12px 的起跳。
  expect(offsetOf(kind)).toBe(100);
  const scrim = element(".pwa-scrim");
  expect(Number(getComputedStyle(scrim).opacity)).toBeCloseTo(1 - 100 / window.innerWidth, 1);
  expect(close).not.toHaveBeenCalled();
  expect(history(kind)).toBeTruthy();
  await release();
  await closed(kind);
}, 15000);

test.each(["tool", "file"] as const)("%s reader reverses back to the start without moving the finger past it", async (kind) => {
  const { origin } = await open(kind);
  await dragTo(origin, 60);
  await moveTouch(origin, 0);
  expect(offsetOf(kind)).toBe(0);
  await moveTouch(origin, -40);
  expect(offsetOf(kind)).toBe(0);
  await release();
  await expect.poll(() => surfaceOf(kind).getAnimations().length).toBe(0);
  expect(offsetOf(kind)).toBe(0);
  expect(close).not.toHaveBeenCalled();
}, 15000);

test.each(["tool", "file"] as const)("%s reader springs back below the threshold and leaves no residue", async (kind) => {
  const { origin } = await open(kind);
  await dragTo(origin, 50);
  expect(offsetOf(kind)).toBeGreaterThan(20);
  await release();
  await expect.poll(() => surfaceOf(kind).getAnimations().length).toBe(0);
  expect(offsetOf(kind)).toBe(0);
  expect(element(".pwa-scrim").getAnimations()).toHaveLength(0);
  expect(close).not.toHaveBeenCalled();
  expect(history(kind)).toBeTruthy();
}, 15000);

test.each(["tool", "file"] as const)("%s reader closes after the settle with one close call and no flash back", async (kind) => {
  const { origin } = await open(kind);
  await dragTo(origin, 140);
  const positions: number[] = [];
  const sample = setInterval(() => { const node = document.querySelector<HTMLElement>(SURFACE[kind]); if (node) positions.push(Math.round(node.getBoundingClientRect().left)); }, 8);
  await release();
  await closed(kind);
  clearInterval(sample);
  // 收尾只会单调靠近右侧终点，不得出现回到起点的一帧。
  expect(Math.min(...positions)).toBeGreaterThan(100);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}, 15000);

test.each(["tool", "file"] as const)("%s reader hands over to popstate mid-drag and keeps moving from the current position", async (kind) => {
  const { origin } = await open(kind);
  await dragTo(origin, 90);
  const before = offsetOf(kind);
  expect(before).toBeGreaterThan(50);
  const positions: number[] = [];
  const sample = setInterval(() => { const node = document.querySelector<HTMLElement>(SURFACE[kind]); if (node) positions.push(Math.round(node.getBoundingClientRect().left)); }, 8);
  window.history.back();
  await expect.poll(() => document.querySelector(SURFACE[kind])).toBeNull();
  clearInterval(sample);
  expect(close).toHaveBeenCalledOnce();
  // Mantine 的退出过渡不得盖过收尾动画：位置从拖动处单调走向右侧终点，没有跳回起点的一帧。
  expect(Math.min(...positions)).toBeGreaterThanOrEqual(before);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  await release();
  expect(close).toHaveBeenCalledOnce();
}, 15000);

test.each(["tool", "file"] as const)("%s reader keeps closing from the current position when the close button is pressed during the spring back", async (kind) => {
  const { origin } = await open(kind);
  await dragTo(origin, 50);
  await release();
  element(kind === "tool" ? ".pwa-tool-reader-close" : ".pwa-file-reader-header button.pwa-icon-button").click();
  await closed(kind);
}, 15000);

test.each(["tool", "file"] as const)("%s reader reopening before the same Drawer exits clears its old drag and keeps history usable", async (kind) => {
  const { origin } = await open(kind);
  await dragTo(origin, 112);
  const original = surfaceOf(kind);
  expect(original.hasAttribute("data-swipe-drag-active")).toBe(true);
  // 冻结退出卸载，而非浏览器历史或动画；真实 history.back 可以在同 DOM 窗口内完成。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  flushSync(() => element(kind === "tool" ? ".pwa-tool-reader-close" : ".pwa-file-reader-header button.pwa-icon-button").click());
  const oldAnimations = original.getAnimations();
  expect(oldAnimations.length).toBeGreaterThan(0);
  expect(close).toHaveBeenCalledOnce();
  // 等待真实历史撤回，但不等待 Drawer 退出；底层组件始终保留。
  await expect.poll(() => history(kind)).toBeUndefined();
  expect(surfaceOf(kind)).toBe(original);
  reopen();
  expect(surfaceOf(kind)).toBe(original);
  // 仅执行 useReaderHistory 的 0ms push，不提前推进 Mantine 的退出时长。
  await vi.advanceTimersByTimeAsync(0);
  await expect.poll(() => history(kind)).toBeTruthy();
  await expect.poll(() => offsetOf(kind)).toBe(0);
  expect(original.hasAttribute("data-swipe-drag-active")).toBe(false);
  expect(oldAnimations.every((animation) => animation.playState === "idle")).toBe(true);
  await frames();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  // 允许重开时原有 CSS 进入过渡正常结束，但旧跟手动画必须已经取消。
  await expect.poll(() => original.getAnimations().length).toBe(0);
  await expect.poll(() => element(".pwa-scrim").getAnimations().length).toBe(0);
  await release();
  await dragTo(origin, 50);
  expect(offsetOf(kind)).toBe(38);
  await release();
  await expect.poll(() => original.getAnimations().length).toBe(0);
  expect(offsetOf(kind)).toBe(0);
  expect(close).toHaveBeenCalledOnce();
  window.history.back();
  await expect.poll(() => document.querySelector(SURFACE[kind])).toBeNull();
  await expect.poll(() => history(kind)).toBeUndefined();
  expect(close).toHaveBeenCalledTimes(2);
}, 15000);

test("tool reader ignores a second press while settling and does not start a new drag", async () => {
  const { origin } = await open("tool");
  await dragTo(origin, 50);
  await release();
  await touch("touchStart", [origin]);
  await moveTouch(origin, LOCK_STEP);
  await moveTouch(origin, 100);
  await touch("touchEnd", []);
  await expect.poll(() => surfaceOf("tool").getAnimations().length).toBe(0);
  expect(close).not.toHaveBeenCalled();
  expect(offsetOf("tool")).toBe(0);
}, 15000);

test("file reader rolls back when a confirmation appears before the close request and keeps the normal exit afterwards", async () => {
  const { origin } = await open("file");
  await dragTo(origin, 140);
  await release();
  modal(true);
  await expect.element(mounted!.getByRole("heading", { name: "Top confirmation" })).toBeVisible();
  // 请求被 hasOtherModal 门禁拒绝：不改 history、不触发 onClose，面板回到起点。
  await expect.poll(() => surfaceOf("file").getAnimations().length).toBe(0);
  expect(offsetOf("file")).toBe(0);
  expect(close).not.toHaveBeenCalled();
  expect(history("file")).toBeTruthy();
  modal(false);
  await expect.poll(() => document.querySelector('[role="dialog"][aria-modal="true"]:not(.pwa-file-reader)')).toBeNull();
  element(".pwa-file-reader-header button.pwa-icon-button").click();
  // 正常关闭仍保留退出动画：点击后面板不会立刻卸载。
  expect(document.querySelector(SURFACE.file)).not.toBeNull();
  await closed("file");
}, 15000);

test("a native touchcancel mid-drag springs back instead of staying halfway", async () => {
  const { origin } = await open("tool");
  await dragTo(origin, 80);
  expect(offsetOf("tool")).toBeGreaterThan(40);
  await touch("touchCancel", []);
  await expect.poll(() => surfaceOf("tool").getAnimations().length).toBe(0);
  expect(offsetOf("tool")).toBe(0);
  expect(close).not.toHaveBeenCalled();
}, 15000);

test("a drag that starts inside the left edge band keeps the trigger behaviour", async () => {
  const { origin } = await open("tool");
  const edge = { ...origin, x: 8 };
  await touch("touchStart", [edge]);
  await moveTouch(edge, LOCK_STEP);
  await moveTouch(edge, 60);
  expect(offsetOf("tool")).toBe(0);
  await moveTouch(edge, 130);
  await release();
  await closed("tool");
}, 15000);

test("reduced motion skips the follow-finger path and keeps the trigger behaviour", async () => {
  await setReducedMotion(true);
  const { origin } = await open("tool");
  await touch("touchStart", [origin]);
  await moveTouch(origin, LOCK_STEP);
  await moveTouch(origin, 60);
  // 减少动态效果下没有位移：面板不跟随手指，也没有拖动动画。
  expect(offsetOf("tool")).toBe(0);
  expect(surfaceOf("tool").getAnimations().length).toBe(0);
  await moveTouch(origin, 130);
  await release();
  await closed("tool");
}, 15000);
