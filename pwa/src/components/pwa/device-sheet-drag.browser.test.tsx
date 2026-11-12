import { afterEach, beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { WorkspaceDeviceControl } from "./workspace-device-control";
import { renderPwa } from "@/test/browser/render";
import { enableTouch, resetTouch, touch, touchOrigin, touchReleaseAtRest, type TouchPoint } from "@/test/browser/swipe";
import type { PwaDeviceRecord } from "@/lib/pwa/db";

const device = (index: number): PwaDeviceRecord => ({
  id: `device:${index}`,
  deviceId: `device-public-key-${index}`,
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  nickname: `Computer ${index}`,
});
const LOCK_STEP = 12;
const events: string[] = [];

const sheet = () => document.querySelector<HTMLElement>(".pwa-device-drawer");
const sheetTop = () => Math.round(sheet()!.getBoundingClientRect().top);
/** CDP 触摸事件与渲染帧异步对齐；等两帧后再断言位置。 */
const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function moveTouch(origin: TouchPoint, dy: number) {
  await touch("touchMove", [{ ...origin, y: origin.y + dy }]);
  await frames();
}
/** 先走过方向锁定帧，再分步下移到 dy；不松手。 */
async function dragDown(origin: TouchPoint, dy: number) {
  await touch("touchStart", [origin]);
  await moveTouch(origin, LOCK_STEP);
  for (let step = 1; step <= 4; step += 1) await moveTouch(origin, LOCK_STEP + (dy - LOCK_STEP) * step / 4);
}

async function open(count: number) {
  events.length = 0;
  const screen = await renderPwa(<WorkspaceDeviceControl
    devices={Array.from({ length: count }, (_, index) => device(index))}
    activeDeviceId="device:0"
    pairingPresence={{}}
    variant="sheet"
    onPair={() => events.push("pair")}
    onSelectDevice={(id) => events.push(`select:${id}`)}
    onRename={() => events.push("rename")}
    onRemove={() => events.push("remove")}
  />);
  await screen.getByRole("button", { name: /Choose computer/ }).click();
  await expect.poll(() => sheet()?.getAnimations().length).toBe(0);
  await expect.poll(() => Math.round(sheet()!.getBoundingClientRect().bottom)).toBe(window.innerHeight);
  return { rest: sheetTop(), head: touchOrigin(document.querySelector(".pwa-device-drawer-head")!, 80) };
}

beforeEach(async () => {
  await page.viewport(390, 700);
  await enableTouch();
});
afterEach(async () => {
  await resetTouch();
  await page.viewport(1280, 900);
});

test("sheet follows the finger downwards and springs back when released short of half its height", async () => {
  const { rest, head } = await open(2);
  await dragDown(head, 62);
  // 面板位移 = 手指位移 − 方向锁定那一帧的位移。
  expect(sheetTop()).toBe(rest + 50);
  const scrim = sheet()!.closest(".mantine-Drawer-root")!.querySelector<HTMLElement>(".pwa-scrim")!;
  expect(Number(getComputedStyle(scrim).opacity)).toBeLessThan(1);
  await touchReleaseAtRest();
  await expect.poll(() => sheet()!.getAnimations().length).toBe(0);
  expect(sheetTop()).toBe(rest);
  expect(events).toEqual([]);
}, 15000);

test("dragging back up past the rest position stops there, keeping the sheet on the bottom edge", async () => {
  const { rest, head } = await open(2);
  await dragDown(head, 62);
  // 反向越过起点：面板贴着屏幕底边，上移会在下方露出空隙，所以停在原位。
  await moveTouch(head, -120);
  expect(sheetTop()).toBe(rest);
  expect(Math.round(sheet()!.getBoundingClientRect().bottom)).toBe(window.innerHeight);
  await touchReleaseAtRest();
  await expect.poll(() => sheet()!.getAnimations().length).toBe(0);
  expect(sheetTop()).toBe(rest);
  expect(events).toEqual([]);
}, 15000);

test("sheet closes once the release point is past half its height, without replaying the exit", async () => {
  const { rest, head } = await open(2);
  const height = sheet()!.offsetHeight;
  await dragDown(head, Math.round(height * 0.75));
  const positions: number[] = [];
  const sample = setInterval(() => { if (sheet()) positions.push(sheetTop()); }, 8);
  await touchReleaseAtRest();
  await expect.poll(() => sheet()).toBeNull();
  clearInterval(sample);
  // 收尾只会单调下行到屏幕外，不出现回到起点的一帧。
  expect(Math.min(...positions)).toBeGreaterThan(rest + height / 2);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(events).toEqual([]);
}, 15000);

test("a drag that starts on the list is also a pull-down while the list fits", async () => {
  const { rest } = await open(2);
  const body = document.querySelector<HTMLElement>(".pwa-device-drawer-body")!;
  expect(body.hasAttribute("data-swipe-vertical")).toBe(false);
  await dragDown(touchOrigin(body.querySelector(".pwa-device-panel-pair")!), 62);
  expect(sheetTop()).toBe(rest + 50);
  await touchReleaseAtRest();
  await expect.poll(() => sheet()!.getAnimations().length).toBe(0);
  // 拖动不算点按：回弹后不触发「配对电脑」。
  expect(events).toEqual([]);
}, 15000);

test("an overflowing list keeps scrolling to the browser and only the header pulls the sheet down", async () => {
  await page.viewport(390, 420);
  const { rest, head } = await open(12);
  const body = document.querySelector<HTMLElement>(".pwa-device-drawer-body")!;
  expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
  expect(body.hasAttribute("data-swipe-vertical")).toBe(true);
  expect(getComputedStyle(body).touchAction).toBe("pan-y");
  await dragDown(touchOrigin(body), 62);
  expect(sheetTop()).toBe(rest);
  await touchReleaseAtRest();
  await dragDown(head, 62);
  expect(sheetTop()).toBe(rest + 50);
  await touchReleaseAtRest();
  await expect.poll(() => sheet()!.getAnimations().length).toBe(0);
  expect(sheetTop()).toBe(rest);
}, 15000);
