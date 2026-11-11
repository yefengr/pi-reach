import { useEffect } from "react";

/** 没有遮罩的浮层：菜单、Popover 与下拉列表。Modal 与 Drawer 自带遮罩，不在此列。 */
const FLOATING = ".mantine-Menu-dropdown, .mantine-Popover-dropdown";
/** 浮层自己的触发器：再点一次由它自行收起，不吞。 */
const OWN_TRIGGER = '[aria-expanded="true"]';
/** 松手后合成的 click 最迟在这段时间内到达；过后撤销拦截，避免误吞之后的点按。 */
const CLICK_FOLLOW_MS = 700;

const swallowed = new WeakSet<Event>();

/** 本次按下是否属于「只关闭浮层」的外部点按；按压反馈据此不显示按下态。 */
export function outsideTapSwallowed(event: Event): boolean {
  return swallowed.has(event);
}

function openFloating(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(FLOATING)].filter((element) =>
    !element.closest('[inert], [aria-hidden="true"]') && element.getClientRects().length > 0);
}

/**
 * 触屏上，菜单或弹层打开时点它外面只关闭它，这一下不再落到下方控件（与系统菜单一致）。
 * 关闭仍由 Mantine 的外部按下监听完成；这里只取消随后的点按：touchend 取消默认行为（不合成 click、不移动焦点），
 * 并在捕获阶段拦下仍然到达的 click。鼠标与触控笔不受影响；手指滑动成滚动时没有点按可吞，滚动照常。
 */
export function useOutsideTapGuard(): void {
  useEffect(() => {
    let armed = false;
    let timer: number | null = null;
    const disarm = () => {
      armed = false;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const down = (event: PointerEvent) => {
      disarm();
      if (event.pointerType !== "touch" || !event.isPrimary || !(event.target instanceof Element)) return;
      const floating = openFloating();
      // 多个浮层叠放时以最后挂载的为最上层：点在它之外（包括下层浮层内）都只关闭它。
      const top = floating[floating.length - 1];
      if (!top || top.contains(event.target) || event.target.closest(OWN_TRIGGER)) return;
      armed = true;
      swallowed.add(event);
    };
    const touchEnd = (event: TouchEvent) => {
      if (armed && event.cancelable) event.preventDefault();
    };
    const up = () => {
      if (!armed || timer !== null) return;
      timer = window.setTimeout(disarm, CLICK_FOLLOW_MS);
    };
    const click = (event: MouseEvent) => {
      if (!armed) return;
      disarm();
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("pointerdown", down, { capture: true, passive: true });
    document.addEventListener("touchend", touchEnd, { capture: true, passive: false });
    document.addEventListener("pointerup", up, { capture: true, passive: true });
    document.addEventListener("pointercancel", disarm, { capture: true, passive: true });
    document.addEventListener("click", click, true);
    return () => {
      disarm();
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("touchend", touchEnd, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", disarm, true);
      document.removeEventListener("click", click, true);
    };
  }, []);
}
