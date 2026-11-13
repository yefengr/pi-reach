// 字号偏好：跟随系统或标准／大／特大三档，放大字号与行内图标，不缩放间距、其他图标与点击区。
// 保持为纯模块，使启动恢复、设置页与测试共用同一存储键与解析规则。
export const TEXT_SIZE_STORAGE_KEY = "pi-reach-text-size";

export type PwaTextSize = "standard" | "large" | "xlarge";
/** 存储的偏好；`system` 按设备的文字大小设置解析到三档之一。 */
export type PwaTextSizePreference = "system" | PwaTextSize;

export const DEFAULT_TEXT_SIZE: PwaTextSize = "standard";
export const DEFAULT_TEXT_SIZE_PREFERENCE: PwaTextSizePreference = "system";

const TEXT_SIZES: readonly PwaTextSize[] = ["standard", "large", "xlarge"];

/** 开发展厅使用受控字号，不继承正式应用的持久化偏好。 */
const REVIEW_ONLY_PATHS = new Set(["/app/ui-states"]);

/**
 * WebKit 的系统正文字体关键字：字号随 iOS「文字大小」设置变化（默认 17px）。
 * 其他浏览器不识别该值，按不支持处理，`system` 偏好回退标准档。
 */
const SYSTEM_BODY_FONT = "-apple-system-body";
/** iOS 文字大小的「加大」为 19px、「特大」为 21px；取相邻两级的中点作为进入大档与特大档的下限。 */
const SYSTEM_LARGE_MIN_PX = 18;
const SYSTEM_XLARGE_MIN_PX = 20;

export function isPwaTextSize(value: unknown): value is PwaTextSize {
  return typeof value === "string" && (TEXT_SIZES as readonly string[]).includes(value);
}

export function isPwaTextSizePreference(value: unknown): value is PwaTextSizePreference {
  return value === "system" || isPwaTextSize(value);
}

/** 非法的档位一律回退标准档，避免旧数据或手工修改破坏布局。 */
export function resolveTextSize(value: string | null | undefined): PwaTextSize {
  return isPwaTextSize(value) ? value : DEFAULT_TEXT_SIZE;
}

/** 缺失或非法的存储值按跟随系统处理；用户选过的档位原样保留。 */
export function resolveTextSizePreference(value: string | null | undefined): PwaTextSizePreference {
  return isPwaTextSizePreference(value) ? value : DEFAULT_TEXT_SIZE_PREFERENCE;
}

/** 把系统正文字号映射到档位；只放大不缩小，小于默认的系统字号仍为标准档。 */
export function textSizeForSystemBody(px: number | null): PwaTextSize {
  if (px === null || !Number.isFinite(px)) return DEFAULT_TEXT_SIZE;
  if (px >= SYSTEM_XLARGE_MIN_PX) return "xlarge";
  if (px >= SYSTEM_LARGE_MIN_PX) return "large";
  return DEFAULT_TEXT_SIZE;
}

/** 只能实测：关键字解析出的字号由系统设置决定。浏览器不支持时返回 null。 */
function measureSystemBodySize(): number | null {
  if (typeof document === "undefined" || typeof CSS === "undefined" || !CSS.supports?.("font", SYSTEM_BODY_FONT)) return null;
  const probe = document.createElement("div");
  probe.style.cssText = `position: absolute; visibility: hidden; font: ${SYSTEM_BODY_FONT}`;
  (document.body ?? document.documentElement).append(probe);
  const size = Number.parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return Number.isFinite(size) && size > 0 ? size : null;
}

let systemBodyProbe: () => number | null = measureSystemBodySize;

/** 当前浏览器能否读到系统文字大小；不能时设置页不提供「跟随系统」。 */
export function supportsSystemTextSize(): boolean {
  return systemBodyProbe() !== null;
}

function resolvePreference(preference: PwaTextSizePreference): PwaTextSize {
  return preference === "system" ? textSizeForSystemBody(systemBodyProbe()) : preference;
}

function readStoredPreference(): PwaTextSizePreference {
  try {
    return resolveTextSizePreference(globalThis.localStorage?.getItem(TEXT_SIZE_STORAGE_KEY));
  } catch {
    return DEFAULT_TEXT_SIZE_PREFERENCE;
  }
}

function writeStoredPreference(preference: PwaTextSizePreference): void {
  try {
    globalThis.localStorage?.setItem(TEXT_SIZE_STORAGE_KEY, preference);
  } catch {
    // 存储不可用时本次访问仍按选择显示。
  }
}

function applyDocumentTextSize(size: PwaTextSize): void {
  if (typeof document !== "undefined") document.documentElement.dataset.pwaTextSize = size;
}

type TextSizeState = Readonly<{ preference: PwaTextSizePreference; size: PwaTextSize }>;

let state: TextSizeState | null = null;
const listeners = new Set<() => void>();

function publish(preference: PwaTextSizePreference): void {
  const next: TextSizeState = { preference, size: resolvePreference(preference) };
  const changed = state === null || state.size !== next.size || state.preference !== next.preference;
  if (changed) state = next;
  applyDocumentTextSize(next.size);
  if (changed) for (const listener of listeners) listener();
}

export function getTextSizeState(): TextSizeState {
  if (state === null) publish(readStoredPreference());
  return state!;
}

export function getTextSize(): PwaTextSize {
  return getTextSizeState().size;
}

export function setTextSize(preference: PwaTextSizePreference): void {
  const next = isPwaTextSizePreference(preference) ? preference : DEFAULT_TEXT_SIZE_PREFERENCE;
  writeStoredPreference(next);
  publish(next);
}

export function subscribeTextSize(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function shouldRestoreTextSize(pathname: string): boolean {
  return !REVIEW_ONLY_PATHS.has(pathname);
}

/** 在 React 渲染前恢复偏好，避免首屏先按标准档排版再跳变。 */
export function applyStoredTextSize(): PwaTextSize {
  publish(readStoredPreference());
  return getTextSize();
}

/** 用户到系统设置调整文字大小后回到应用时重新解析；手动选定档位时不受影响。 */
export function installSystemTextSizeTracking(): () => void {
  const refresh = () => {
    if (document.visibilityState === "visible" && state?.preference === "system") publish("system");
  };
  document.addEventListener("visibilitychange", refresh);
  return () => document.removeEventListener("visibilitychange", refresh);
}

/** 仅供测试：替换系统字号探针（传 null 恢复实测），并丢弃缓存状态。 */
export function setSystemBodyProbeForTest(probe: (() => number | null) | null): void {
  systemBodyProbe = probe ?? measureSystemBodySize;
  state = null;
}

/** 仅供测试：丢弃缓存状态与根节点标记，下次读取时重新解析存储。 */
export function resetTextSizeStateForTest(): void {
  state = null;
  if (typeof document !== "undefined") document.documentElement.removeAttribute("data-pwa-text-size");
}
