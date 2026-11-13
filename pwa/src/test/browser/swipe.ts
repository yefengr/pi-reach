import { cdp } from "vitest/browser";
import { vi } from "vitest";

export function pointer(target: Element | Window, type: string, x = 0, y = 0, init: PointerEventInit = {}) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, ...init }));
}

/** 合成事件的时间戳由浏览器生成、几乎同时到达；需要确定松手速度的用例用它指定毫秒时间。 */
export function pointerAt(target: Element | Window, type: string, x: number, y: number, time: number, init: PointerEventInit = {}) {
  const event = new PointerEvent(type, { bubbles: true, composed: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, ...init });
  Object.defineProperty(event, "timeStamp", { value: time });
  target.dispatchEvent(event);
}

export function syntheticSwipe(target: Element, dx = 100, dy = 0, init: PointerEventInit = {}) {
  pointer(target, "pointerdown", 0, 0, init);
  pointer(target, "pointermove", dx / 2, dy / 2, init);
  pointer(target, "pointerup", dx, dy, init);
}

/** 仅用于合成 PointerEvent；CDP 测试不得调用。 */
export function syntheticCapture(surface: HTMLElement) {
  const held = new Set<number>();
  const set = vi.spyOn(surface, "setPointerCapture").mockImplementation((id) => { held.add(id); });
  const has = vi.spyOn(surface, "hasPointerCapture").mockImplementation((id) => held.has(id));
  const release = vi.spyOn(surface, "releasePointerCapture").mockImplementation((id) => { held.delete(id); });
  return { set, has, release, held };
}

let activeTouch = false;

export async function enableTouch() {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
}

export async function resetTouch() {
  if (activeTouch) await touch("touchCancel", []);
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
}

export type TouchPoint = { x: number; y: number; id: number };

/** CDP 坐标属于顶层 viewport，测试组件位于 Vitest 的 tester iframe。 */
function viewportPoint(point: TouchPoint) {
  let x = point.x;
  let y = point.y;
  let frame: Window = window;
  while (frame.frameElement) {
    const rect = frame.frameElement.getBoundingClientRect();
    x = rect.left + x * rect.width / frame.innerWidth;
    y = rect.top + y * rect.height / frame.innerHeight;
    frame = frame.parent;
  }
  return { x, y, id: point.id };
}

export async function touch(type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", points: TouchPoint[]) {
  await cdp().send("Input.dispatchTouchEvent", { type, touchPoints: points.map(viewportPoint) });
  activeTouch = points.length > 0;
}

export function touchOrigin(element: Element, insetX?: number, insetY?: number): TouchPoint {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + (insetX ?? rect.width / 2), y: rect.top + (insetY ?? rect.height / 2), id: 1 };
}

export async function touchDrag(origin: TouchPoint, dx: number, dy: number) {
  await touch("touchStart", [origin]);
  for (let step = 1; step <= 8; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await touch("touchMove", [{ ...origin, x: origin.x + dx * step / 8, y: origin.y + dy * step / 8 }]);
  }
  await touch("touchEnd", []);
}

/** 松手速度按最后 100ms 采样；多等一段，确保采样窗口内没有位移。 */
const TOUCH_REST_MS = 180;

/** 停稳后松手：松手速度为 0，跟手手势提交与否只看停点是否过行程一半，不随机器快慢变化。 */
export async function touchReleaseAtRest() {
  const until = performance.now() + TOUCH_REST_MS;
  // 以渲染帧计时：用例冻结 setTimeout 时仍能推进。
  while (performance.now() < until) await new Promise((resolve) => requestAnimationFrame(resolve));
  await touch("touchEnd", []);
}

export async function touchTap(origin: TouchPoint) {
  await touch("touchStart", [origin]);
  await touch("touchEnd", []);
}
