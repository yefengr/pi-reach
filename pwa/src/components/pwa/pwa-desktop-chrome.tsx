import { DesktopSidebar, type WorkspaceNavigationProps } from "@/components/pwa/workspace-view";

type PwaDesktopNavigationProps = {
  navigation: WorkspaceNavigationProps;
  collapsed: boolean;
};

export function PwaDesktopNavigation({ navigation, collapsed }: PwaDesktopNavigationProps) {
  return <DesktopSidebar {...navigation} collapsed={collapsed} />;
}
