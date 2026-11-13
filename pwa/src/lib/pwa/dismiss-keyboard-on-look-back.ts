import { MOBILE_LAYOUT_QUERY, TOUCH_INPUT_QUERY } from "@/lib/ui/viewport-queries";

/** 手指在消息列表上向下拖过这段距离（内容朝更早的方向移动）即收起键盘；小于它的抖动与轻点不算回看。 */
export const LOOK_BACK_DISMISS_PX = 24;
const COMPOSER_INPUT = ".pwa-chat-footer textarea";

/**
 * 触屏移动布局下，输入框聚焦时在消息列表上向回看方向拖动即让输入框失焦、收起软键盘，草稿保留（DESIGN「软键盘」）。
 * 只看用户的触摸：用 touch 事件而不是 pointer 事件，浏览器接管滚动后 pointer 事件即被取消；程序滚动与朝最新方向的拖动不触发。
 * 每次按下只判定一次，按下时输入框未聚焦则整次手势不处理。
 */
export function observeKeyboardDismissOnLookBack(list: HTMLElement): () => void {
  let start: { id: number; x: number; y: number } | null = null;
  const focusedInput = () => {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement && active.matches(COMPOSER_INPUT) ? active : null;
  };
  const down = (event: TouchEvent) => {
    start = null;
    if (event.touches.length !== 1 || !focusedInput()) return;
    if (!window.matchMedia(MOBILE_LAYOUT_QUERY).matches || !window.matchMedia(TOUCH_INPUT_QUERY).matches) return;
    const touch = event.touches[0];
    start = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
  };
  const move = (event: TouchEvent) => {
    if (!start) return;
    if (event.touches.length !== 1) { start = null; return; }
    const touch = event.touches[0];
    if (touch.identifier !== start.id) { start = null; return; }
    const dy = touch.clientY - start.y;
    if (dy < LOOK_BACK_DISMISS_PX || dy <= Math.abs(touch.clientX - start.x)) return;
    start = null;
    focusedInput()?.blur();
  };
  const end = () => { start = null; };
  list.addEventListener("touchstart", down, { passive: true });
  list.addEventListener("touchmove", move, { passive: true });
  list.addEventListener("touchend", end, { passive: true });
  list.addEventListener("touchcancel", end, { passive: true });
  return () => {
    list.removeEventListener("touchstart", down);
    list.removeEventListener("touchmove", move);
    list.removeEventListener("touchend", end);
    list.removeEventListener("touchcancel", end);
  };
}
