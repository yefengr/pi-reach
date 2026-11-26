export const HAIRLINE_ATTRIBUTE = "data-pwa-hairline";

function resolveRoot(root?: HTMLElement): HTMLElement | undefined {
  return root ?? (typeof document === "undefined" ? undefined : document.documentElement);
}

/** 实测边框的排版高度；DPR 只触发重测，不代表浏览器支持半像素。 */
export function detectHairline(root?: HTMLElement): boolean {
  const target = resolveRoot(root);
  if (!target) return false;
  let probe: HTMLElement | undefined;
  let supported = false;
  try {
    probe = target.ownerDocument.createElement("div");
    probe.style.cssText = "position: absolute; visibility: hidden; box-sizing: content-box; width: 0; height: 0; min-height: 0; padding: 0; margin: 0; border: 0; border-top: 0.5px solid transparent";
    // 放在目标内部，隐藏或脱离布局的目标不能误报支持。
    target.append(probe);
    const height = probe.getBoundingClientRect().height;
    supported = height > 0 && height < 1;
  } catch {
    supported = false;
  } finally {
    probe?.remove();
  }
  target.toggleAttribute(HAIRLINE_ATTRIBUTE, supported);
  return supported;
}

type Installation = { count: number; dispose: () => void };
const installations = new WeakMap<HTMLElement, Installation>();

/** 多次安装共享监听；最后释放恢复首次安装前的属性（包括原始值）。 */
export function installHairlineDetection(root?: HTMLElement): () => void {
  const target = resolveRoot(root);
  const view = target?.ownerDocument.defaultView;
  if (!target || !view) return () => {};
  let state = installations.get(target);
  if (!state) {
    const original = target.getAttribute(HAIRLINE_ATTRIBUTE);
    let unbindResolution = () => {};
    const refresh = () => {
      detectHairline(target);
      unbindResolution();
      unbindResolution = () => {};
      // 每次密度改变都绑定当前分辨率，而非只观察是否跨过 2dppx。
      if (!view.matchMedia) return;
      const query = view.matchMedia(`(resolution: ${view.devicePixelRatio || 1}dppx)`);
      if (query.addEventListener) {
        query.addEventListener("change", refresh);
        unbindResolution = () => query.removeEventListener("change", refresh);
      } else {
        query.addListener(refresh);
        unbindResolution = () => query.removeListener(refresh);
      }
    };
    refresh();
    view.addEventListener("resize", refresh);
    state = {
      count: 0,
      dispose: () => {
        unbindResolution();
        view.removeEventListener("resize", refresh);
        if (original === null) target.removeAttribute(HAIRLINE_ATTRIBUTE);
        else target.setAttribute(HAIRLINE_ATTRIBUTE, original);
      },
    };
    installations.set(target, state);
  }
  state.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--state.count) return;
    state.dispose();
    installations.delete(target);
  };
}
