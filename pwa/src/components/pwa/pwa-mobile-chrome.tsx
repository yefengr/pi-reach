import { SessionSheet } from "@/components/pwa/session-sheet";
import type { NavigationGesture } from "@/components/pwa/use-navigation-drag";
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
  /** 设置页返回拖动中的导航预览：不启用焦点陷阱与滚动锁，也不主动聚焦。 */
  preview?: boolean;
  gesture?: NavigationGesture | null;
  onExitTransitionEnd?: () => void;
};

export function PwaMobileNavigation({ navigation, opened, onClose, focusOrigin, instant, restoreScrollTop, focusSettings, preview, gesture, onExitTransitionEnd }: PwaMobileNavigationProps) {
  // 导航挂在工作区视图内，设置页推入／返回时随工作区一起移动。
  return <SessionSheet {...navigation} opened={opened} onClose={onClose} focusOrigin={focusOrigin} instant={instant} restoreScrollTop={restoreScrollTop} focusSettings={focusSettings} preview={preview} gesture={gesture} onExitTransitionEnd={onExitTransitionEnd} portalTarget=".pwa-workspace-view" />;
}
