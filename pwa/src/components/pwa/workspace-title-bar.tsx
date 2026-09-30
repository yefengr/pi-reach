import type { ReactNode } from "react";
import { ActionIcon, UnstyledButton } from "@mantine/core";
import { Menu, RefreshCw } from "lucide-react";
import { refreshPwaApp } from "@/lib/pwa/service-worker-update";
import { useI18n } from "@/lib/i18n";

export type WorkspaceTitleBarProps = {
  /** 当前会话名；移动端导航入口在没有会话时显示电脑名或「导航」。 */
  title: string;
  /** 桌面标题区是否显示会话名；没有打开会话时只保留状态与操作。 */
  showTitle: boolean;
  /** 会话名前的工作目录最后一级。 */
  prefix?: string | null;
  /** 会话名上方的小字，如「本地历史 · 只读」。 */
  kicker?: string | null;
  status?: ReactNode;
  moreMenu?: ReactNode;
  /** 移动端菜单图标右上角的后台完成提醒圆点。 */
  navigationNotice?: boolean;
  navigationExpanded: boolean;
  onOpenNavigation: (origin: HTMLButtonElement) => void;
  onRefresh?: () => void | Promise<unknown>;
};

/**
 * 会话标题区：桌面为主区顶部 56px 的一行，移动端即工作区顶栏（菜单图标与会话名共同构成导航入口）。
 */
export function WorkspaceTitleBar({ title, showTitle, prefix, kicker, status, moreMenu, navigationNotice = false, navigationExpanded, onOpenNavigation, onRefresh = refreshPwaApp }: WorkspaceTitleBarProps) {
  const { t } = useI18n();
  return <header className="pwa-title-bar">
    <UnstyledButton
      className="pwa-session-trigger"
      onClick={(event) => onOpenNavigation(event.currentTarget)}
      aria-label={t.navigation.open}
      aria-haspopup="dialog"
      aria-expanded={navigationExpanded}
      title={title}
    >
      <span className="pwa-session-trigger-icon" aria-hidden="true"><Menu size={20} />{navigationNotice ? <span className="pwa-notice-dot" /> : null}</span>
      <span className="pwa-session-trigger-copy">{kicker ? <span className="pwa-session-trigger-kicker">{kicker}</span> : null}<span className="pwa-session-trigger-title">{title}</span></span>
    </UnstyledButton>
    <div className="pwa-title-bar-heading">
      {showTitle ? <>
        {kicker ? <span className="pwa-title-bar-kicker">{kicker}</span> : null}
        <h1 className="pwa-title-bar-name" title={prefix ? `${prefix} · ${title}` : title}>
          {prefix ? <span className="pwa-title-bar-prefix">{prefix}<span aria-hidden="true"> · </span></span> : null}
          <span className="pwa-title-bar-title">{title}</span>
        </h1>
      </> : null}
    </div>
    <div className="pwa-title-bar-actions">
      {status}
      <ActionIcon className="pwa-title-bar-refresh" type="button" onClick={() => { void onRefresh(); }} aria-label={t.navigation.refreshApp} title={t.navigation.refreshApp}>
        <RefreshCw size={20} />
      </ActionIcon>
      {moreMenu}
    </div>
  </header>;
}
