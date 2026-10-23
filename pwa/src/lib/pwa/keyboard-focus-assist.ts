export type FocusAssistNavigator = Pick<Navigator, "userAgent" | "maxTouchPoints">;
export type KeyboardTap = Readonly<{ x: number; y: number; time: number }>;

const IOS_USER_AGENT = /\b(?:iPhone|iPad|iPod)\b/i;
const DESKTOP_IPAD_USER_AGENT = /\bMacintosh\b/i;
// 触点移动超过该距离视为滚动或拖选，交还原生处理。
const TAP_SLOP_PX = 10;
// 长按用于原生选择与放大镜，不接管。
const TAP_MAX_MS = 500;
// 聚焦瞬间把输入框挪到顶栏下方，任何键盘高度下都在可见区内，iOS 无需平移页面。
const ASSIST_TOP_PX = 120;

/** iOS／iPadOS 的 WebKit 才会在弹出键盘时自行平移页面。 */
export function isIosTouchWebKit(device: FocusAssistNavigator | undefined = globalThis.navigator): boolean {
  if (!device) return false;
  if (IOS_USER_AGENT.test(device.userAgent)) return true;
  return DESKTOP_IPAD_USER_AGENT.test(device.userAgent) && device.maxTouchPoints > 1;
}

export function readKeyboardTap(event: TouchEvent, now = performance.now()): KeyboardTap | null {
  const touch = event.touches.length === 1 ? event.touches[0] : undefined;
  return touch ? { x: touch.clientX, y: touch.clientY, time: now } : null;
}

function isTap(start: KeyboardTap | null, event: TouchEvent, now: number): boolean {
  const touch = event.changedTouches.length === 1 ? event.changedTouches[0] : undefined;
  if (!start || !touch || event.touches.length > 0) return false;
  return Math.hypot(touch.clientX - start.x, touch.clientY - start.y) <= TAP_SLOP_PX && now - start.time <= TAP_MAX_MS;
}

/**
 * 首次轻点未聚焦的输入框时由应用接管聚焦：同一任务内临时上移、无滚动聚焦再复位，中间不发生绘制。
 * 返回 true 时调用方须阻止默认行为，避免原生聚焦再次触发页面平移。
 */
export function assistKeyboardFocus(input: HTMLTextAreaElement, start: KeyboardTap | null, event: TouchEvent,
  now = performance.now(), device?: FocusAssistNavigator): boolean {
  if (!isIosTouchWebKit(device) || document.activeElement === input || input.readOnly || input.disabled) return false;
  if (!isTap(start, event, now)) return false;
  const shift = Math.max(0, input.getBoundingClientRect().top - ASSIST_TOP_PX);
  const previous = input.style.getPropertyValue("translate");
  if (shift > 0) input.style.setProperty("translate", `0 ${-shift}px`);
  try {
    input.focus({ preventScroll: true });
  } finally {
    if (previous) input.style.setProperty("translate", previous);
    else input.style.removeProperty("translate");
  }
  // 接管后原生不会按触点放置光标；首次聚焦统一放到末尾，便于继续输入草稿。
  const end = input.value.length;
  input.setSelectionRange(end, end);
  return true;
}
