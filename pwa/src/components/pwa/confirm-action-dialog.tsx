import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { localizeFeedback } from "@/lib/pwa/feedback-messages";
import { useI18n, type Messages } from "@/lib/i18n";

export type ConfirmActionDialogAction =
  | { kind: "new-session" }
  | { kind: "remove-pairing"; label: string }
  | { kind: "clear-local-data" }
  | { kind: "leave-attachments" };

type ConfirmActionDialogProps = {
  action: ConfirmActionDialogAction | null;
  pending: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
  onExitTransitionEnd?: () => void;
  withinPortal?: boolean;
};

type DialogCopy = {
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  destructive: boolean;
};

function dialogCopy(action: ConfirmActionDialogAction, t: Messages["confirm"], attachments: Messages["attachments"]): DialogCopy {
  switch (action.kind) {
    case "leave-attachments":
      return { title: attachments.leaveTitle, description: attachments.leaveBody, confirmLabel: attachments.leaveConfirm, pendingLabel: attachments.leaveConfirm, destructive: false };
    case "new-session":
      return {
        title: t.newSessionTitle,
        description: t.newSessionBody,
        confirmLabel: t.newSessionConfirm,
        pendingLabel: t.newSessionPending,
        destructive: false,
      };
    case "remove-pairing":
      return {
        title: t.removeTitle(action.label),
        description: t.removeBody,
        confirmLabel: t.removeConfirm,
        pendingLabel: t.removePending,
        destructive: true,
      };
    case "clear-local-data":
      return {
        title: t.clearTitle,
        description: t.clearBody,
        confirmLabel: t.clearConfirm,
        pendingLabel: t.clearPending,
        destructive: true,
      };
  }
}

export function ConfirmActionDialog({ action, pending, error, onConfirm, onClose, onExitTransitionEnd, withinPortal = true }: ConfirmActionDialogProps) {
  const { t, locale } = useI18n();
  const visibleAction = action ?? { kind: "new-session" };
  const copy = dialogCopy(visibleAction, t.confirm, t.attachments);
  // 危险确认是确认弹窗的最后一步，使用实心错误色；其余确认为主操作。
  const confirmButtonProps = copy.destructive ? { variant: "filled" as const, color: "red", className: "pwa-danger-confirm" } : {};
  const titleId = "pwa-confirm-action-title";
  const descriptionId = "pwa-confirm-action-description";

  return <Modal
    opened={action !== null}
    onClose={onClose}
    title={<div><span className="pwa-kicker">{t.confirm.kicker}</span><Text component="h2" id={titleId} className="pwa-confirm-title">{copy.title}</Text></div>}
    aria-labelledby={titleId}
    aria-describedby={descriptionId}
    centered
    size={400}
    withinPortal={withinPortal}
    portalProps={{ target: ".pwa-root" }}
    zIndex={310}
    trapFocus
    returnFocus
    onExitTransitionEnd={onExitTransitionEnd}
    closeOnClickOutside={!pending}
    closeOnEscape={!pending}
    closeButtonProps={{ disabled: pending, "aria-label": t.confirm.close, title: t.confirm.close }}
    classNames={{ content: "pwa-confirm-dialog", header: "pwa-confirm-head", close: "pwa-icon-button" }}
    styles={{ header: { minHeight: 0, padding: 0 }, body: { padding: 0 } }}
  >
    <Stack gap={0}>
      <Text component="p" id={descriptionId} className="pwa-confirm-description">{copy.description}</Text>
      {error ? <Text component="p" className="pwa-confirm-error" role="alert">{localizeFeedback(error, locale)}</Text> : null}
      <Group className="pwa-confirm-actions" justify="flex-end" gap="xs">
        <Button variant="default" type="button" onClick={onClose} disabled={pending}>{visibleAction.kind === "leave-attachments" ? t.attachments.leaveCancel : t.common.cancel}</Button>
        <Button {...confirmButtonProps} type="button" onClick={onConfirm} disabled={pending}>{pending ? copy.pendingLabel : copy.confirmLabel}</Button>
      </Group>
    </Stack>
  </Modal>;
}
