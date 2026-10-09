import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { ActionIcon } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type WorkspaceNavigationProps } from "@/components/pwa/workspace-view";
import { PwaDesktopNavigation } from "@/components/pwa/pwa-desktop-chrome";
import { PwaMobileNavigation } from "@/components/pwa/pwa-mobile-chrome";
import { PwaRuntimeNoticeSlot } from "@/components/pwa/pwa-app-shell";
import { WorkspaceTitleBar, type WorkspaceTitleBarProps } from "@/components/pwa/workspace-title-bar";
import { usePageTransition } from "@/components/pwa/use-page-transition";
import { useWorkspaceDrag } from "@/components/pwa/use-workspace-drag";
import { useNavigationDrag } from "@/components/pwa/use-navigation-drag";
import { useSwipe } from "@/components/pwa/use-swipe";
import type { SettingsOrigin, SettingsRoute } from "@/lib/pwa/settings-route";
import { useI18n } from "@/lib/i18n";

const MOBILE_QUERY = "(max-width: 767.98px)";

function focusable(element: HTMLElement | null): element is HTMLElement {
  return Boolean(element?.isConnected && !element.matches(":disabled") && !element.closest('[aria-hidden="true"], [inert]') && element.getClientRects().length > 0);
}

type PwaWorkspaceLayoutProps = {
  navigation: WorkspaceNavigationProps;
  titleBar: Omit<WorkspaceTitleBarProps, "onOpenNavigation" | "navigationExpanded">;
  historyMode: boolean;
  children: ReactNode;
  connectionBanner?: ReactNode;
  toast: ReactNode;
  operationNotifications?: ReactNode;
  settingsRoute: SettingsRoute;
  onOpenSettings: (origin: SettingsOrigin) => void;
  onSettingsBack: () => void;
  /** 设置页内容；返回按钮文案由来源决定，故以函数接收。 */
  renderSettings: (props: { backLabel: string; titleRef: RefObject<HTMLHeadingElement | null> }) => ReactNode;
  overlays: ReactNode;
  closeBackgroundOverlay: (close: () => void) => void;
};

export function PwaWorkspaceLayout({
  navigation,
  titleBar,
  historyMode,
  children,
  connectionBanner,
  toast,
  operationNotifications,
  settingsRoute,
  onOpenSettings,
  onSettingsBack,
  renderSettings,
  overlays,
  closeBackgroundOverlay,
}: PwaWorkspaceLayoutProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const noticesRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const [settingsElement, setSettingsElement] = useState<HTMLDivElement | null>(null);
  const setSettingsRef = useCallback((element: HTMLDivElement | null) => {
    settingsRef.current = element;
    setSettingsElement(element);
  }, []);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const settingsTitleRef = useRef<HTMLHeadingElement | null>(null);
  // 设置页在进入与返回转场期间保持挂载；返回转场结束后卸载。
  const [settingsMounted, setSettingsMounted] = useState(settingsRoute.open);
  const [transitioning, setTransitioning] = useState(false);
  const [seenChange, setSeenChange] = useState(settingsRoute.change);
  const [sheetInstant, setSheetInstant] = useState(false);
  const [sheetRestore, setSheetRestore] = useState<{ scrollTop: number } | null>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage<boolean>({ key: "pi-reach-sidebar-collapsed", defaultValue: false });
  const sidebarToggleRef = useRef<HTMLButtonElement | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetOpenRef = useRef(sheetOpen);
  useLayoutEffect(() => { sheetOpenRef.current = sheetOpen; }, [sheetOpen]);
  const [sheetMounted, setSheetMounted] = useState(false);
  const sheetMountedRef = useRef(sheetMounted);
  useLayoutEffect(() => { sheetMountedRef.current = sheetMounted; }, [sheetMounted]);
  const [sheetFocusOrigin, setSheetFocusOrigin] = useState<HTMLElement | null>(null);
  const [mainElement, setMainElement] = useState<HTMLElement | null>(null);
  const openNavigation = useCallback((origin: HTMLElement | null) => {
    setSheetFocusOrigin(origin);
    setSheetMounted(true);
    setSheetOpen(true);
  }, []);
  const presentFrameRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (presentFrameRef.current !== null) cancelAnimationFrame(presentFrameRef.current);
  }, []);
  /**
   * 点击图标或触发式滑动打开导航。Drawer 随 opened=true 一起挂载时 Mantine 视为初始已进入、不播放进入动画，
   * 因此未挂载时先同步挂载收起态，下一帧再打开；跟手拖动需要同步打开，仍直接调用 openNavigation。
   */
  const presentNavigation = useCallback((origin: HTMLElement | null) => {
    if (presentFrameRef.current !== null) return;
    if (sheetMountedRef.current) {
      openNavigation(origin);
      return;
    }
    flushSync(() => {
      setSheetFocusOrigin(origin);
      setSheetMounted(true);
    });
    presentFrameRef.current = requestAnimationFrame(() => {
      presentFrameRef.current = null;
      // 等待的一帧内已切到桌面布局则放弃；收起态实例保留，下次打开直接过渡。
      if (window.matchMedia(MOBILE_QUERY).matches) setSheetOpen(true);
    });
  }, [openNavigation]);
  const navigationDrag = useNavigationDrag({ rootRef, mainElement, sheetOpen, setSheetOpen, openNavigation });
  const releaseNavigationDrag = navigationDrag.onExitTransitionEnd;
  const onNavigationExitTransitionEnd = useCallback(() => {
    // 旧退出通知不得释放新一轮手势或卸载快速重开的导航。
    if (sheetOpenRef.current) return;
    releaseNavigationDrag();
    // 完整退出后释放实例，让下一轮跟手打开同步挂载全新的 Drawer；点击打开由 presentNavigation 先挂载再打开。
    setSheetMounted(false);
  }, [releaseNavigationDrag]);
  useSwipe(mainElement, {
    direction: "right",
    // 只豁免本次拖动自己设置的 sheetOpen；设置页、转场等其余门禁照常生效。
    enabled: !settingsRoute.open && !transitioning && (!sheetOpen || navigationDrag.gesture === "dragging"),
    onSwipe: () => presentNavigation(mainElement?.querySelector<HTMLElement>(".pwa-session-trigger") ?? null),
    canSwipe: navigationDrag.canSwipe,
    drag: navigationDrag.drag,
  });
  if (seenChange !== settingsRoute.change) {
    setSeenChange(settingsRoute.change);
    if (settingsRoute.open) {
      setSettingsMounted(true);
      // 重新进入即结束前次恢复请求；连续反向即使值相同，也必须形成新的恢复边界。
      setSheetRestore(null);
    }
    setTransitioning(settingsRoute.animate);
    const origin = settingsRoute.origin;
    if (!settingsRoute.open && origin?.kind === "navigation" && typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches) {
      // 返回导航：以展开态直接呈现（不播放打开动画），恢复滚动位置，焦点落在设置入口。
      setSheetInstant(true);
      setSheetRestore({ scrollTop: origin.scrollTop });
      setSheetMounted(true);
      setSheetOpen(true);
    }
  }
  useEffect(() => {
    const viewport = window.matchMedia("(max-width: 767.98px)");
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (!event.matches) setSheetOpen(false);
    };
    viewport.addEventListener("change", closeOnDesktop);
    return () => viewport.removeEventListener("change", closeOnDesktop);
  }, []);
  const onSettled = useCallback((change: number) => {
    if (change !== settingsRoute.change) return;
    setTransitioning(false);
    if (settingsRoute.open) {
      // 从导航进入：导航叠层被设置层覆盖后直接关闭，不单独播放关闭动画；状态已记入设置页记录。
      setSheetOpen(false);
      setSheetMounted(false);
    } else {
      setSettingsMounted(false);
      setSheetInstant(false);
      setSheetRestore(null);
    }
  }, [settingsRoute.change, settingsRoute.open]);
  const pageTransition = usePageTransition({ open: settingsRoute.open, change: settingsRoute.change, animate: settingsRoute.animate, rootRef, workspaceRef, settingsRef, scrimRef, onSettled });
  const beginNavigationPreview = useCallback((scrollTop: number) => {
    // 与返回导航的路由分支一致：展开态直接呈现并恢复滚动位置，但工作区仍 inert，导航只是返回预览。
    setSheetInstant(true);
    setSheetRestore({ scrollTop });
    setSheetMounted(true);
    setSheetOpen(true);
  }, []);
  const endNavigationPreview = useCallback(() => {
    setSheetOpen(false);
    setSheetMounted(false);
    setSheetInstant(false);
    setSheetRestore(null);
  }, []);
  const workspaceDrag = useWorkspaceDrag({ settingsRoute, transitioning, rootRef, settingsRef, scrimRef, pageTransition, onSettingsBack, beginNavigationPreview, endNavigationPreview });
  useSwipe(settingsElement, {
    direction: "right",
    enabled: settingsRoute.open && (!transitioning || workspaceDrag.dragging),
    onSwipe: onSettingsBack,
    canSwipe: workspaceDrag.canSwipe,
    drag: workspaceDrag.drag,
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    const notices = noticesRef.current;
    if (!root || !notices) return;
    // Toast 挂在根节点上，按主区居中并落在主区提示下方，避免压到侧栏或连接提示。
    const measure = () => {
      const base = root.getBoundingClientRect();
      const box = notices.getBoundingClientRect();
      root.style.setProperty("--pwa-main-notices-bottom", `${box.bottom - base.top}px`);
      root.style.setProperty("--pwa-main-center", `${box.left + box.width / 2 - base.left}px`);
      root.style.setProperty("--pwa-main-width", `${box.width}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    // 标题区变高（含安全区内边距）时提示区整体下移但自身尺寸不变，也需要重新测量。
    for (const element of [notices, root, notices.parentElement, notices.previousElementSibling]) if (element) observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (settingsRoute.change === 0) return;
    if (settingsRoute.open) {
      settingsTitleRef.current?.focus({ preventScroll: true });
      return;
    }
    // 返回导航时焦点由导航内设置入口的 data-autofocus 接管。
    if (settingsRoute.origin?.kind === "navigation" && window.matchMedia(MOBILE_QUERY).matches) return;
    const target = [".pwa-desktop-navigation .pwa-nav-settings", ".pwa-session-trigger"]
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .find(focusable);
    target?.focus({ preventScroll: true });
  }, [settingsRoute.change, settingsRoute.open, settingsRoute.origin]);

  useEffect(() => {
    if (!settingsRoute.open) return;
    const previous = document.title;
    document.title = t.settings.pageTitle;
    return () => { document.title = previous; };
  }, [settingsRoute.open, t.settings.pageTitle]);

  const desktopNavigation: WorkspaceNavigationProps = { ...navigation, onSettings: () => onOpenSettings({ kind: "workspace" }) };
  const mobileNavigation: WorkspaceNavigationProps = {
    ...navigation,
    onSettings: () => onOpenSettings({ kind: "navigation", scrollTop: document.querySelector<HTMLElement>(".pwa-session-sheet .pwa-navigation-scroll")?.scrollTop ?? 0 }),
    onRename: (device) => {
      navigation.onRename(device);
      setSheetOpen(false);
    },
  };
  const toggleSidebar = () => {
    if (!sidebarCollapsed) {
      const activeElement = document.activeElement;
      const navigationOwnsFocus = activeElement instanceof HTMLElement && (
        document.getElementById("pwa-desktop-navigation")?.contains(activeElement)
        || Boolean(activeElement.closest(".pwa-device-panel, .pwa-peer-menu-panel"))
      );
      if (navigationOwnsFocus) sidebarToggleRef.current?.focus({ preventScroll: true });
    }
    setSidebarCollapsed((value) => !value);
  };
  const toggleLabel = sidebarCollapsed ? t.navigation.expandSidebar : t.navigation.collapseSidebar;

  const backLabel = settingsRoute.origin?.kind === "navigation" ? t.settings.backToNavigation : t.settings.backToWorkspace;
  const settingsView = settingsRoute.open ? "settings" : "workspace";

  return <div ref={rootRef} className="pwa-root" data-view={settingsView} data-view-transition={transitioning || workspaceDrag.dragging || undefined} data-sidebar-collapsed={sidebarCollapsed || undefined}>
    <div ref={workspaceRef} className="pwa-workspace-view" inert={settingsRoute.open || undefined}>
    <div className="pwa-layout">
      <div id="pwa-desktop-navigation" className="pwa-desktop-navigation" inert={sidebarCollapsed} aria-hidden={sidebarCollapsed || undefined}><PwaDesktopNavigation navigation={desktopNavigation} collapsed={sidebarCollapsed} /></div>
      {/* 收展入口展开时在侧栏品牌行右端，收起后在会话标题区左端。 */}
      <ActionIcon ref={sidebarToggleRef} className="pwa-sidebar-toggle" type="button" aria-label={toggleLabel} title={toggleLabel} aria-expanded={!sidebarCollapsed} aria-controls="pwa-desktop-navigation" onPointerDown={(event) => { if (event.pointerType === "mouse") event.preventDefault(); }} onClick={toggleSidebar}>
        {sidebarCollapsed ? <ChevronRight size={20} /> : <ChevronLeft size={20} />}
      </ActionIcon>
      <main ref={setMainElement} className={`pwa-main${historyMode ? " pwa-history-main" : ""}`}>
        <WorkspaceTitleBar {...titleBar} navigationExpanded={sheetOpen} onOpenNavigation={presentNavigation} />
        <div ref={noticesRef} className="pwa-main-notices">
          {historyMode ? null : connectionBanner}
          {toast}
          {operationNotifications}
          <PwaRuntimeNoticeSlot />
        </div>
        {children}
      </main>
    </div>
    {sheetMounted ? <PwaMobileNavigation navigation={mobileNavigation} opened={sheetOpen || navigationDrag.gesture === "dragging"} onClose={() => closeBackgroundOverlay(() => setSheetOpen(false))} focusOrigin={navigationDrag.gesture === "rollback" ? null : sheetFocusOrigin} instant={sheetInstant} restoreScrollTop={sheetRestore?.scrollTop} focusSettings={sheetRestore !== null} preview={workspaceDrag.previewing} gesture={navigationDrag.gesture} onExitTransitionEnd={onNavigationExitTransitionEnd} /> : null}
    </div>
    {settingsMounted ? <div ref={scrimRef} className="pwa-page-scrim" aria-hidden="true" /> : null}
    {settingsMounted ? <div ref={setSettingsRef} className="pwa-settings-view" inert={!settingsRoute.open || undefined} role="main" aria-labelledby="pwa-settings-title">{renderSettings({ backLabel, titleRef: settingsTitleRef })}</div> : null}
    {overlays}
  </div>;
}
