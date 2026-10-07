import { useCallback, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";

export const APP_PATH = "/app";
export const SETTINGS_PATH = "/app/settings";

/** 进入设置前的界面：桌面工作区，或已展开的移动导航及其滚动位置。 */
export type SettingsOrigin =
  | { kind: "workspace" }
  | { kind: "navigation"; scrollTop: number };

type SettingsHistoryEntry = { origin: SettingsOrigin | null };

export type SettingsRoute = {
  open: boolean;
  /** 当前或最近一次设置页记录的来源；直接打开设置页时为 null。 */
  origin: SettingsOrigin | null;
  /** 这次切换是否播放推入／返回转场；首屏直接打开时不播放。 */
  animate: boolean;
  /** 每次切换递增，供转场与焦点逻辑区分先后。 */
  change: number;
};

export type AppRoute = "workspace" | "settings" | "unknown";

function trimTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/** 只解释 /app 下的产品路由；其他地址（如组件测试页）一律视为工作区且不改写。 */
export function routeForPath(pathname: string): AppRoute {
  const path = trimTrailingSlash(pathname);
  if (path === SETTINGS_PATH) return "settings";
  if (path === APP_PATH || !path.startsWith(`${APP_PATH}/`)) return "workspace";
  return "unknown";
}

function settingsEntry(state: unknown): SettingsHistoryEntry | null {
  if (typeof state !== "object" || state === null || !("piReachSettings" in state)) return null;
  const entry = (state as { piReachSettings: unknown }).piReachSettings;
  if (typeof entry !== "object" || entry === null) return null;
  const origin = (entry as { origin?: unknown }).origin;
  if (typeof origin !== "object" || origin === null) return { origin: null };
  const kind = (origin as { kind?: unknown }).kind;
  if (kind === "workspace") return { origin: { kind } };
  if (kind === "navigation") {
    const scrollTop = (origin as { scrollTop?: unknown }).scrollTop;
    return { origin: { kind, scrollTop: typeof scrollTop === "number" && Number.isFinite(scrollTop) ? scrollTop : 0 } };
  }
  return { origin: null };
}

function withoutSettings(state: unknown): Record<string, unknown> {
  if (typeof state !== "object" || state === null) return {};
  const rest = { ...(state as Record<string, unknown>) };
  delete rest.piReachSettings;
  return rest;
}

function underApp(pathname: string): boolean {
  return pathname === APP_PATH || pathname.startsWith(`${APP_PATH}/`);
}

/**
 * 首屏整理地址：未识别的 /app 子路径改回 /app；直接打开 /app/settings 时先把当前记录换成工作区，
 * 再压入设置页记录，保证返回后再后退不会回到设置页。已由本应用写入的设置页记录（如刷新）保持原样。
 */
export function normalizeInitialRoute(): SettingsRoute {
  const route = routeForPath(window.location.pathname);
  const entry = settingsEntry(window.history.state);
  const search = `${window.location.search}${window.location.hash}`;
  if (route === "unknown") {
    window.history.replaceState(withoutSettings(window.history.state), "", `${APP_PATH}${search}`);
    return { open: false, origin: null, animate: false, change: 0 };
  }
  // /app 之外（如组件测试页）只以内存状态打开设置页，首屏一律为工作区。
  if (route !== "settings") return { open: false, origin: null, animate: false, change: 0 };
  if (entry) return { open: true, origin: entry.origin, animate: false, change: 0 };
  window.history.replaceState(withoutSettings(window.history.state), "", `${APP_PATH}${search}`);
  window.history.pushState({ piReachSettings: { origin: null } }, "", `${SETTINGS_PATH}${search}`);
  return { open: true, origin: null, animate: false, change: 0 };
}

/**
 * 设置页路由：进入时 pushState 一条记录并在 state 中保存来源；页内返回与浏览器／系统后退都回到上一条记录，
 * 由 popstate 统一恢复。前进重新进入设置页时同样播放进入转场。
 */
export function useSettingsRoute() {
  const [route, setRoute] = useState<SettingsRoute>(() => normalizeInitialRoute());

  useLayoutEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const entry = settingsEntry(event.state);
      const nativeTransition = event.hasUAVisualTransition === true;
      const updateRoute = () => setRoute((current) => {
        if (entry) return current.open ? current : { open: true, origin: entry.origin, animate: !nativeTransition, change: current.change + 1 };
        return current.open ? { open: false, origin: current.origin, animate: !nativeTransition, change: current.change + 1 } : current;
      });
      // UA 已提供视觉转场：在事件返回前提交目标界面，不再叠加应用转场。
      if (nativeTransition) flushSync(updateRoute);
      else updateRoute();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const openSettings = useCallback((origin: SettingsOrigin) => {
    if (settingsEntry(window.history.state)) return;
    const search = `${window.location.search}${window.location.hash}`;
    // /app 下使用真实子路径；其他地址只写 history state，不改变 URL。
    window.history.pushState({ piReachSettings: { origin } }, "", underApp(window.location.pathname) ? `${SETTINGS_PATH}${search}` : undefined);
    setRoute((current) => ({ open: true, origin, animate: true, change: current.change + 1 }));
  }, []);

  const closeSettings = useCallback(() => {
    if (!settingsEntry(window.history.state)) {
      setRoute((current) => current.open ? { open: false, origin: current.origin, animate: true, change: current.change + 1 } : current);
      return;
    }
    // 页内返回不新建记录，回到上一条（工作区或导航）记录。
    window.history.back();
  }, []);

  return { route, openSettings, closeSettings };
}

/** 清除本地数据等需要重新载入时回到工作区，不停留在设置页。 */
export function reloadWorkspace(): void {
  if (routeForPath(window.location.pathname) === "workspace") window.location.reload();
  else window.location.replace(`${APP_PATH}${window.location.search}`);
}
