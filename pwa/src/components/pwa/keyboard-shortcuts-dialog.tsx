import { Modal } from "@mantine/core";
import { useI18n } from "@/lib/i18n";
import { shortcutLabel, useEnterSends, type ShortcutAction } from "@/lib/pwa/keyboard-shortcuts";

const ACTIONS: readonly ShortcutAction[] = ["send", "sendAlternative", "newline", "toggleSidebar", "openSettings", "showHelp", "closeOverlay"];

type KeyboardShortcutsDialogProps = {
  opened: boolean;
  onClose: () => void;
  /** 路由切换时由目标页面接管焦点，不返回旧页面的来源。 */
  returnFocus: boolean;
  enterSends?: boolean;
};

export function KeyboardShortcutsDialog({ enterSends, ...props }: KeyboardShortcutsDialogProps) {
  return enterSends === undefined ? <PersistedKeyboardShortcutsDialog {...props} /> : <KeyboardShortcutsDialogContent {...props} enterSends={enterSends} />;
}

function PersistedKeyboardShortcutsDialog(props: Omit<KeyboardShortcutsDialogProps, "enterSends">) {
  const [enterSends] = useEnterSends();
  return <KeyboardShortcutsDialogContent {...props} enterSends={enterSends} />;
}

function KeyboardShortcutsDialogContent({ opened, onClose, returnFocus, enterSends }: Omit<KeyboardShortcutsDialogProps, "enterSends"> & { enterSends: boolean }) {
  const { t } = useI18n();
  return <Modal
    opened={opened}
    onClose={onClose}
    title={t.shortcuts.title}
    size={480}
    portalProps={{ target: ".pwa-root" }}
    zIndex={310}
    returnFocus={returnFocus}
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
