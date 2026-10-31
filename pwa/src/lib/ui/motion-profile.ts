// 评估期临时开关：内容与空间层的动效风格（P4 iOS 弹簧／P2 舒缓／P3 减速），定稿后连同设置项一起删除。
// 取值写在根节点 data-pwa-motion 上，由 pwa-theme.css 覆盖 token；脚本与 Mantine 读取根节点计算值，随之切换。
export const MOTION_PROFILE_STORAGE_KEY = "pi-reach-motion-profile";

export type PwaMotionProfile = "spring" | "symmetric" | "decelerate";

export const DEFAULT_MOTION_PROFILE: PwaMotionProfile = "spring";
export const MOTION_PROFILES: readonly PwaMotionProfile[] = ["spring", "symmetric", "decelerate"];

function resolveMotionProfile(value: string | null | undefined): PwaMotionProfile {
  return (MOTION_PROFILES as readonly (string | null | undefined)[]).includes(value) ? value as PwaMotionProfile : DEFAULT_MOTION_PROFILE;
}

function readStoredMotionProfile(): PwaMotionProfile {
  try {
    return resolveMotionProfile(globalThis.localStorage?.getItem(MOTION_PROFILE_STORAGE_KEY));
  } catch {
    return DEFAULT_MOTION_PROFILE;
  }
}

function applyDocumentMotionProfile(profile: PwaMotionProfile): void {
  if (typeof document !== "undefined") document.documentElement.dataset.pwaMotion = profile;
}

// 读取不产生副作用：只有启动恢复与设置页的选择会写入根节点，展厅与组件测试保持主题默认值。
let current: PwaMotionProfile = DEFAULT_MOTION_PROFILE;
const listeners = new Set<() => void>();

export function getMotionProfile(): PwaMotionProfile {
  return current;
}

export function setMotionProfile(profile: PwaMotionProfile): void {
  const next = resolveMotionProfile(profile);
  try {
    globalThis.localStorage?.setItem(MOTION_PROFILE_STORAGE_KEY, next);
  } catch {
    // 存储不可用时本次访问仍按选择显示。
  }
  applyDocumentMotionProfile(next);
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeMotionProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 在 React 渲染前恢复，避免首屏按默认风格读取时长后再切换。 */
export function applyStoredMotionProfile(): PwaMotionProfile {
  current = readStoredMotionProfile();
  applyDocumentMotionProfile(current);
  return current;
}

/** 仅供测试：回到默认风格并移除根节点标记。 */
export function resetMotionProfileForTest(): void {
  current = DEFAULT_MOTION_PROFILE;
  if (typeof document !== "undefined") delete document.documentElement.dataset.pwaMotion;
}
