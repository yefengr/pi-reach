import { Modal } from "@mantine/core";
import { useI18n } from "@/lib/i18n";
import { shortcutLabel, useEnterSends, type ShortcutAction } from "@/lib/pwa/keyboard-shortcuts";

const ACTIONS: readonly ShortcutAction[] = ["send", "sendAlternative", "newline", "toggleSidebar", "openSettings", "showHelp", "closeOverlay"];

type KeyboardShortcutsDialogProps = {
  opened: boolean;
  onClose: () => void;
};

export function KeyboardShortcutsDialog({ opened, onClose }: KeyboardShortcutsDialogProps) {
  const { t } = useI18n();
  const [enterSends] = useEnterSends();
  return <Modal
    opened={opened}
    onClose={onClose}
    title={t.shortcuts.title}
    size={480}
    portalProps={{ target: ".pwa-root" }}
    zIndex={310}
    returnFocus
    inert={!opened}
    closeButtonProps={{ "aria-label": t.common.close, title: t.common.close }}
    classNames={{ content: "pwa-keyboard-dialog", title: "pwa-keyboard-title", close: "pwa-icon-button" }}
  >
    <p className="pwa-keyboard-note">{t.shortcuts.hint}</p>
    <dl className="pwa-keyboard-list">
      {ACTIONS.filter((action) => enterSends || action !== "sendAlternative").map((action) => <div key={action} data-shortcut={action}>
        <dt>{t.shortcuts[action]}</dt>
        <dd><kbd>{shortcutLabel(action, enterSends)}</kbd></dd>
      </div>)}
    </dl>
    <p className="pwa-keyboard-note">{t.shortcuts.workingHint}</p>
  </Modal>;
}
