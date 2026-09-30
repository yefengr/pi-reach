import { ActionIcon, Alert, Button } from "@mantine/core";
import { ArrowDownToLine, CircleAlert, RefreshCw, WifiOff, X } from "lucide-react";
import type { ConnectionViewState } from "@/components/pwa/workspace-view";
import { localizeFeedback, safeFeedbackMessage } from "@/lib/pwa/feedback-messages";
import { useI18n } from "@/lib/i18n";

type MessageActionsProps = {
  show: boolean;
  showRetry: boolean;
  showLatest: boolean;
  unreadOutput: number;
  onRetry: () => void;
  onLatest: () => void;
};

type StatusToastProps = {
  message: string | null;
  onDismiss: () => void;
};



export function PwaMessageActions({ show, showRetry, showLatest, unreadOutput, onRetry, onLatest }: MessageActionsProps) {
  const { t } = useI18n();
  if (!show || (!showRetry && !showLatest)) return null;

  return (
    <div className="pwa-message-actions">
      {showRetry ? <Button variant="default" className="pwa-latest-button" type="button" leftSection={<RefreshCw size={16} />} onClick={onRetry}>{t.actions.tryAgain}</Button> : null}
      {showLatest ? <Button variant="default" className="pwa-latest-button" type="button" leftSection={<ArrowDownToLine size={16} />} onClick={onLatest}>{unreadOutput > 0 ? t.actions.newOutput(unreadOutput) : t.actions.latest}</Button> : null}
    </div>
  );
}

export type PwaConnectionBannerKind = "relay" | "network";

/** 断线超过该时长才显示连接提示条；集成测试可调短。 */
export const connectionBannerTiming = { delayMs: 10_000 };

type ConnectionBannerProps = {
  kind: PwaConnectionBannerKind;
  connection: ConnectionViewState;
  onRetry?: () => void;
  retryDisabled?: boolean;
};

export function PwaConnectionBanner({ kind, connection, onRetry, retryDisabled = false }: ConnectionBannerProps) {
  const { t } = useI18n();
  const reconnecting = kind === "relay" && (connection === "connecting" || connection === "retrying");
  const message = kind === "network"
    ? t.connection.networkUnavailable
    : reconnecting ? t.connection.relayRetrying : t.connection.unavailable;

  return (
    <Alert
      className={`pwa-connection-banner pwa-connection-banner-${kind}`}
      classNames={{ wrapper: "pwa-connection-banner-wrapper", icon: "pwa-connection-banner-icon", body: "pwa-connection-banner-body", message: "pwa-connection-banner-message" }}
      role="status"
      variant="light"
      icon={kind === "network" ? <WifiOff size={20} aria-hidden="true" /> : <CircleAlert size={20} aria-hidden="true" />}
    >
      <div className="pwa-connection-banner-content">
        <span>{message}</span>
        {onRetry ? <Button
          variant="default"
          className="pwa-connection-retry"
          type="button"
          leftSection={<RefreshCw size={16} aria-hidden="true" />}
          loading={connection === "connecting"}
          disabled={retryDisabled || connection === "connecting" || connection === "no_network"}
          onClick={onRetry}
        >{t.connection.retryNow}</Button> : null}
      </div>
    </Alert>
  );
}

export function PwaStatusToast({ message, onDismiss }: StatusToastProps) {
  const { t, locale } = useI18n();
  const safeMessage = safeFeedbackMessage(message);
  if (!safeMessage) return null;

  return (
    <div className="pwa-toast" role="status">
      <span>{localizeFeedback(safeMessage, locale)}</span>
      <ActionIcon className="pwa-toast-dismiss" type="button" onClick={onDismiss} aria-label={t.common.dismiss}>
        <X size={16} />
      </ActionIcon>
    </div>
  );
}
