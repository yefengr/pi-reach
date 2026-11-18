import { useEffect, useRef } from "react";

/**
 * 移动导航入口的输入方式标记：原生 :focus-visible 仍是显示焦点的唯一前提，
 * 只在最近一次交互是普通触摸时抑制入口圆圈，避免抽屉关闭后的程序化回焦在
 * 部分浏览器被判为可见焦点。未知初始状态不写标记，继续走原生规则。
 */
export function useNavigationFocusRing<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const doc = element.ownerDocument;
    const win = doc.defaultView ?? window;
    let touch = false;
    const sync = () => element.toggleAttribute("data-navigation-touch", touch);
    const clear = () => {
      if (!touch) return;
      touch = false;
      sync();
    };
    // 键盘、鼠标或触控笔的后续交互都恢复原生焦点规则。
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") {
        clear();
        return;
      }
      if (touch) return;
      touch = true;
      sync();
    };
    // 读屏等虚拟激活的 click 没有指针计数，按键盘处理；真实触摸点击的 detail ≥ 1。
    const onClick = (event: MouseEvent) => {
      if (event.detail === 0) clear();
    };
    const onKeyDown = () => clear();
    // 窗口失焦后无法确定回来时的输入方式，交回原生规则，不遗留抑制标记。
    const onBlur = () => clear();
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener("click", onClick, true);
    win.addEventListener("blur", onBlur);
    return () => {
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
      doc.removeEventListener("click", onClick, true);
      win.removeEventListener("blur", onBlur);
      element.removeAttribute("data-navigation-touch");
    };
  }, []);
  return ref;
}
