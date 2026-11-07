import { useLayoutEffect } from "react";

/** 可视高度比同宽度的无键盘基准矮出这么多才认定软键盘弹出；浏览器工具栏伸缩只有几十 px，iPad 外接键盘的快捷栏约 55px。 */
const KEYBOARD_MIN_HEIGHT = 120;
export const SOFT_KEYBOARD_ATTRIBUTE = "data-soft-keyboard";
export const SOFT_KEYBOARD_BASELINE_KEY = "pi-reach-soft-keyboard-baselines";

/** open：已检测到软键盘，输入区随即停靠。 */
export type SoftKeyboardState = "open";
type Baselines = Record<string, number>;

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

function editableFocused(): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) return !active.readOnly && !active.disabled;
  if (active instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(active.type) && !active.readOnly && !active.disabled;
  return active instanceof HTMLElement && active.isContentEditable;
}

function readBaselines(): Baselines {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SOFT_KEYBOARD_BASELINE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0));
  } catch { return {}; }
}

function writeBaselines(baselines: Baselines) {
  try { window.localStorage.setItem(SOFT_KEYBOARD_BASELINE_KEY, JSON.stringify(baselines)); } catch { /* 存储不可用时只在本次运行内生效 */ }
}

/**
 * 按可视窗口高度判断软键盘，只在根节点打标记，不补偿外壳尺寸、不锁文档高度、不复位滚动（DESIGN「软键盘」）。
 * 基准：没有可编辑元素聚焦时键盘必然收起，此时的可视高度即该显示模式与可视宽度下的无键盘基准，每次读到都覆盖，
 * 过时的值随之纠正；按显示模式与宽度存入本地，键盘开着时旋转到新宽度也有基准可比。以宽度而非屏幕方向区分：
 * 键盘只改变高度，旋转与分屏必然改变宽度，且宽高在同一次 resize 中更新。
 * 时机：iOS 在整页上推开始的那一帧把可视高度一次变到终点，脚本约在上推开始后 50ms 读到，之后不再有进度；检测到即标记，
 * 输入区以 keyboard-dock 停靠，与剩余的上推同时结束，停靠并入上推、不再单独出现。页面缩放时可视尺寸与键盘无关，不更新判断。
 * 只标记浏览器平移页面的情形（布局视口不变、只缩小可视窗口，如 iOS）：浏览器缩小布局视口时（安卓 Chrome 执行
 * interactive-widget=resizes-content），外壳已随视口贴住键盘，输入区无需停靠，不打标记。
 */
export function observeSoftKeyboard(root: HTMLElement): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const baselines = readBaselines();
  const close = () => root.removeAttribute(SOFT_KEYBOARD_ATTRIBUTE);
  const update = (event?: Event) => {
    if (viewport.scale !== 1) return;
    const mode = window.matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser";
    const key = `${mode}:${Math.round(viewport.width)}`;
    if (!editableFocused()) {
      // 失焦那一刻键盘尚未收起，只在初始化与尺寸变化时记基准。
      if (event?.type !== "focusout" && event?.type !== "focusin" && baselines[key] !== viewport.height) {
        baselines[key] = viewport.height;
        writeBaselines(baselines);
      }
      close();
      return;
    }
    const baseline = baselines[key];
    if (baseline === undefined || viewport.height >= baseline - KEYBOARD_MIN_HEIGHT) {
      close();
      return;
    }
    // 根元素 clientHeight 即布局视口高度：平移时保持不变，缩小视口时随键盘变矮、与可视高度相近。
    if (document.documentElement.clientHeight - viewport.height < KEYBOARD_MIN_HEIGHT) {
      close();
      return;
    }
    // 已停靠后键盘高度再变化（切换表情键盘等）不重复写入。
    if (root.getAttribute(SOFT_KEYBOARD_ATTRIBUTE) === "open") return;
    root.setAttribute(SOFT_KEYBOARD_ATTRIBUTE, "open" satisfies SoftKeyboardState);
  };
  update();
  viewport.addEventListener("resize", update);
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", update);
  return () => {
    viewport.removeEventListener("resize", update);
    document.removeEventListener("focusin", update);
    document.removeEventListener("focusout", update);
    close();
  };
}

export function useSoftKeyboard() {
  useLayoutEffect(() => observeSoftKeyboard(document.documentElement), []);
}
