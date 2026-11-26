// 字号偏好：跟随系统或标准／大／特大三档，放大字号与行内图标，不缩放间距、其他图标与点击区。
// 保持为纯模块，使启动恢复、设置页与测试共用同一存储键与解析规则。
export const TEXT_SIZE_STORAGE_KEY = "pi-reach-text-size";

import { readSystemBodySize, textSizeForSystemBody, type PwaTextSize, type PwaTextSizePreference } from "@yefengr/pwa-foundation";
export { textSizeForSystemBody } from "@yefengr/pwa-foundation";
export type { PwaTextSize, PwaTextSizePreference } from "@yefengr/pwa-foundation";

export const DEFAULT_TEXT_SIZE: PwaTextSize = "standard";
export const DEFAULT_TEXT_SIZE_PREFERENCE: PwaTextSizePreference = "system";

const TEXT_SIZES: readonly PwaTextSize[] = ["standard", "large", "xlarge"];

/** 开发展厅使用受控字号，不继承正式应用的持久化偏好。 */
const REVIEW_ONLY_PATHS = new Set(["/app/ui-states"]);

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

let systemBodyProbe: () => number | null = readSystemBodySize;

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

/** 只改当前页面的档位、不写存储：开发展厅用它让实际字号与内存中的选择保持同一份。 */
export function previewTextSize(preference: PwaTextSizePreference): void {
  publish(isPwaTextSizePreference(preference) ? preference : DEFAULT_TEXT_SIZE_PREFERENCE);
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
  systemBodyProbe = probe ?? readSystemBodySize;
  state = null;
}

/** 仅供测试：丢弃缓存状态与根节点标记，下次读取时重新解析存储。 */
export function resetTextSizeStateForTest(): void {
  state = null;
  if (typeof document !== "undefined") document.documentElement.removeAttribute("data-pwa-text-size");
}
