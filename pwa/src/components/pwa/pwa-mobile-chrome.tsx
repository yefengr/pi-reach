import { SessionSheet } from "@/components/pwa/session-sheet";
import type { WorkspaceNavigationProps } from "@/components/pwa/workspace-view";

type PwaMobileNavigationProps = {
  navigation: WorkspaceNavigationProps;
  opened?: boolean;
  onClose: () => void;
  focusOrigin: HTMLElement | null;
  /** 从设置页返回时以展开态直接呈现，不播放打开动画。 */
  instant?: boolean;
  restoreScrollTop?: number;
  focusSettings?: boolean;
};

export function PwaMobileNavigation({ navigation, opened, onClose, focusOrigin, instant, restoreScrollTop, focusSettings }: PwaMobileNavigationProps) {
  // 导航挂在工作区视图内，设置页推入／返回时随工作区一起移动。
  return <SessionSheet {...navigation} opened={opened} onClose={onClose} focusOrigin={focusOrigin} instant={instant} restoreScrollTop={restoreScrollTop} focusSettings={focusSettings} portalTarget=".pwa-workspace-view" />;
}
