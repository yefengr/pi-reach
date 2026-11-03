export const SIDEBAR_WIDTH_KEY = "pi-reach-sidebar-width";
export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 360;
export const SIDEBAR_KEYBOARD_STEP = 8;
export const SIDEBAR_OUTER_GAP = 12;
export const MAIN_MIN_WIDTH = 480;

export function sidebarWidthPreference(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= SIDEBAR_MIN_WIDTH && value <= SIDEBAR_MAX_WIDTH ? value : SIDEBAR_DEFAULT_WIDTH;
}

export function parseSidebarWidth(stored: string | null): number {
  try { return sidebarWidthPreference(stored === null ? null : JSON.parse(stored)); }
  catch { return SIDEBAR_DEFAULT_WIDTH; }
}

export function sidebarWidthCap(rootWidth: number, safeLeft = 0, safeRight = 0): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, rootWidth - safeLeft - safeRight - SIDEBAR_OUTER_GAP - MAIN_MIN_WIDTH));
}

export function clampSidebarWidth(width: number, cap: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(width, cap));
}
