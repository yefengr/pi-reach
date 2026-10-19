// 字号偏好：标准／大／特大，只放大字号，不缩放间距、图标与点击区。
// 保持为纯模块，使启动恢复、设置页与测试共用同一存储键与解析规则。
export const TEXT_SIZE_STORAGE_KEY = "pi-reach-text-size";

export type PwaTextSize = "standard" | "large" | "xlarge";

export const DEFAULT_TEXT_SIZE: PwaTextSize = "standard";

const TEXT_SIZES: readonly PwaTextSize[] = ["standard", "large", "xlarge"];

export function isPwaTextSize(value: unknown): value is PwaTextSize {
  return typeof value === "string" && (TEXT_SIZES as readonly string[]).includes(value);
}

/** 非法或缺失的存储值一律回退标准档，避免旧数据或手工修改破坏布局。 */
export function resolveTextSize(value: string | null | undefined): PwaTextSize {
  return isPwaTextSize(value) ? value : DEFAULT_TEXT_SIZE;
}

function readStoredTextSize(): PwaTextSize {
  try {
    return resolveTextSize(globalThis.localStorage?.getItem(TEXT_SIZE_STORAGE_KEY));
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

function writeStoredTextSize(size: PwaTextSize): void {
  try {
    globalThis.localStorage?.setItem(TEXT_SIZE_STORAGE_KEY, size);
  } catch {
    // 存储不可用时本次访问仍按选择显示。
  }
}

function applyDocumentTextSize(size: PwaTextSize): void {
  if (typeof document !== "undefined") document.documentElement.dataset.pwaTextSize = size;
}

type TextSizeState = Readonly<{ size: PwaTextSize }>;

let state: TextSizeState | null = null;
const listeners = new Set<() => void>();

function publish(next: TextSizeState): void {
  const changed = state === null || state.size !== next.size;
  state = next;
  applyDocumentTextSize(next.size);
  if (changed) for (const listener of listeners) listener();
}

export function getTextSizeState(): TextSizeState {
  if (state === null) publish({ size: readStoredTextSize() });
  return state!;
}

export function getTextSize(): PwaTextSize {
  return getTextSizeState().size;
}

export function setTextSize(size: PwaTextSize): void {
  const next = isPwaTextSize(size) ? size : DEFAULT_TEXT_SIZE;
  writeStoredTextSize(next);
  publish({ size: next });
}

export function subscribeTextSize(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 在 React 渲染前恢复偏好，避免首屏先按标准档排版再跳变。 */
export function applyStoredTextSize(): PwaTextSize {
  const size = readStoredTextSize();
  state = { size };
  applyDocumentTextSize(size);
  return size;
}

/** 仅供测试：丢弃缓存状态与根节点标记，下次读取时重新解析存储。 */
export function resetTextSizeStateForTest(): void {
  state = null;
  if (typeof document !== "undefined") document.documentElement.removeAttribute("data-pwa-text-size");
}
