import type { ReactNode } from "react";
import { ActionIcon, UnstyledButton } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { MOBILE_LAYOUT_QUERY } from "@/lib/ui/viewport-queries";
import { Menu, RefreshCw } from "lucide-react";
import { refreshPwaApp } from "@/lib/pwa/service-worker-update";
import { useI18n } from "@/lib/i18n";

export type WorkspaceTitleBarProps = {
  /** 当前会话名；移动端导航入口在没有会话时显示电脑名或「导航」。 */
  title: string;
  /** 桌面标题区是否显示会话名；没有打开会话时只保留状态与操作。 */
  showTitle: boolean;
  /** 会话名下方显示的工作目录最后一级（项目名）。 */
  prefix?: string | null;
  status?: ReactNode;
  moreMenu?: ReactNode;
  /** 移动端菜单图标右上角的后台完成提醒圆点。 */
  navigationNotice?: boolean;
  navigationExpanded: boolean;
  onOpenNavigation: (origin: HTMLButtonElement) => void;
  onRefresh?: () => void | Promise<unknown>;
};

/**
 * 会话标题区：桌面首行沿用 48px 顶栏带并对齐右侧操作，会话名下方是项目名一行；
 * 移动端即工作区顶栏（菜单图标与会话名共同构成导航入口），不显示项目行。
 */
export function WorkspaceTitleBar({ title, showTitle, prefix, status, moreMenu, navigationNotice = false, navigationExpanded, onOpenNavigation, onRefresh = refreshPwaApp }: WorkspaceTitleBarProps) {
  const { t } = useI18n();
  // 按断点卸载入口及其 Portal，避免桌面留下隐藏焦点或重现已打开的信息层。
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  return <header className="pwa-topbar pwa-title-bar">
    <UnstyledButton
      className="pwa-session-trigger"
      onClick={(event) => onOpenNavigation(event.currentTarget)}
      aria-label={t.navigation.open}
      aria-haspopup="dialog"
      aria-expanded={navigationExpanded}
      title={title}
    >
      <span className="pwa-session-trigger-icon" aria-hidden="true"><Menu size={20} />{navigationNotice ? <span className="pwa-notice-dot" /> : null}</span>
      <span className="pwa-session-trigger-copy"><span className="pwa-session-trigger-title">{title}</span></span>
    </UnstyledButton>
    <div className="pwa-title-bar-heading">
      {showTitle ? <>
        <h1 className="pwa-title-bar-name" title={title}>{title}</h1>
        {prefix ? <div className="pwa-title-bar-project" title={prefix}>{prefix}</div> : null}
      </> : null}
    </div>
    <div className="pwa-title-bar-actions">
      {status}
      <ActionIcon className="pwa-title-bar-refresh" type="button" onClick={() => { void onRefresh(); }} aria-label={t.navigation.refreshApp} title={t.navigation.refreshApp}>
        <RefreshCw size={20} />
      </ActionIcon>
      {mobile ? moreMenu : null}
    </div>
  </header>;
}
