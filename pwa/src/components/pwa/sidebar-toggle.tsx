import type { Ref } from "react";
import { ActionIcon } from "@mantine/core";
import { PanelLeft } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { shortcutLabel } from "@/lib/pwa/keyboard-shortcuts";

/** 桌面侧栏收展入口：正式工作区与开发展厅共用，位置由 `.pwa-sidebar-toggle` 样式按收展状态决定。 */
export function SidebarToggle({ collapsed, onToggle, ref }: { collapsed: boolean; onToggle: () => void; ref?: Ref<HTMLButtonElement> }) {
  const { t } = useI18n();
  const label = collapsed ? t.navigation.expandSidebar : t.navigation.collapseSidebar;
  const shortcut = shortcutLabel("toggleSidebar");
  return <ActionIcon ref={ref} className="pwa-sidebar-toggle" type="button" aria-label={label} title={`${label} (${shortcut})`}
    aria-keyshortcuts={shortcut.replaceAll(" ", "").replace("⌘", "Meta").replace("Ctrl", "Control")} aria-expanded={!collapsed} aria-controls="pwa-desktop-navigation"
    onPointerDown={(event) => { if (event.pointerType === "mouse") event.preventDefault(); }} onClick={onToggle}>
    {/* 展开与收起用同一个侧栏图标：状态由侧栏本身可见，可访问名称与悬停说明区分动作；20px 下方框内的小箭头难以辨认。 */}
    <PanelLeft size={20} />
  </ActionIcon>;
}
