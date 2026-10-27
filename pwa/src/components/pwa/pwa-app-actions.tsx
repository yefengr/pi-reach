import { ActionIcon, Alert, Button } from "@mantine/core";
import { ArrowDownToLine, CircleAlert, RefreshCw, WifiOff, X } from "lucide-react";
import type { ConnectionViewState } from "@/components/pwa/workspace-view";
import { localizeFeedback, safeFeedbackMessage } from "@/lib/pwa/feedback-messages";
import { useI18n } from "@/lib/i18n";
import { presenceProps, usePresence } from "./use-presence";

type MessageActionsProps = {
  show: boolean;
  showRetry: boolean;
  showLatest: boolean;
  unreadOutput: number;
  onRetry: () => void;
  onLatest: () => void;
};

type StatusErrorProps = {
  message: string | null;
  onDismiss: () => void;
};



export function PwaMessageActions({ show, showRetry, showLatest, unreadOutput, onRetry, onLatest }: MessageActionsProps) {
  const { t } = useI18n();
  // 两个入口各自进出：一个出现或消失时另一个不重播；离开时保留最后的未读计数，淡出期间文字不变。
  const retry = usePresence(show && showRetry ? true : null);
  const latest = usePresence(show && showLatest ? unreadOutput : null);
  if (retry.rendered === null && latest.rendered === null) return null;

  return (
    <div className="pwa-message-actions">
      {retry.rendered !== null ? <span className="pwa-message-action pwa-presence pwa-presence-float" {...presenceProps(retry)}><Button variant="default" className="pwa-latest-button" type="button" leftSection={<RefreshCw size={16} />} onClick={onRetry}>{t.actions.tryAgain}</Button></span> : null}
      {latest.rendered !== null ? <span className="pwa-message-action pwa-presence pwa-presence-float" {...presenceProps(latest)}><Button variant="default" className="pwa-latest-button" type="button" leftSection={<ArrowDownToLine size={16} />} onClick={onLatest}>{latest.rendered > 0 ? t.actions.newOutput(latest.rendered) : t.actions.latest}</Button></span> : null}
    </div>
  );
}

export type PwaConnectionBannerKind = "relay" | "network";

/** 断线超过该时长才显示连接提示条；集成测试可调短。 */
export const connectionBannerTiming = { delayMs: 10_000 };

type ConnectionBannerProps = {
  /** null 表示不显示；变为 null 后保留最后的提示淡出。 */
  kind: PwaConnectionBannerKind | null;
  connection: ConnectionViewState;
  onRetry?: () => void;
  retryDisabled?: boolean;
};

type ConnectionBannerView = { kind: PwaConnectionBannerKind; message: string };
const sameBanner = (left: ConnectionBannerView, right: ConnectionBannerView) => left.kind === right.kind && left.message === right.message;

export function PwaConnectionBanner({ kind, connection, onRetry, retryDisabled = false }: ConnectionBannerProps) {
  const { t } = useI18n();
  const reconnecting = kind === "relay" && (connection === "connecting" || connection === "retrying");
  const message = kind === "network"
    ? t.connection.networkUnavailable
    : reconnecting ? t.connection.relayRetrying : t.connection.unavailable;
  // 恢复连接后提示条淡出；淡出期间保留断线时的文案，不跳成「无法连接」。
  const presence = usePresence(kind === null ? null : { kind, message }, sameBanner);
  const view = presence.rendered;
  if (!view) return null;

  return (
    <Alert
      {...presenceProps(presence)}
      className={`pwa-connection-banner pwa-connection-banner-${view.kind} pwa-presence`}
      classNames={{ wrapper: "pwa-connection-banner-wrapper", icon: "pwa-connection-banner-icon", body: "pwa-connection-banner-body", message: "pwa-connection-banner-message" }}
      role="status"
      variant="light"
      icon={view.kind === "network" ? <WifiOff size={20} aria-hidden="true" /> : <CircleAlert size={20} aria-hidden="true" />}
    >
      <div className="pwa-connection-banner-content">
        <span>{view.message}</span>
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

export function PwaStatusError({ message, onDismiss }: StatusErrorProps) {
  const { t, locale } = useI18n();
  const safeMessage = safeFeedbackMessage(message);
  // 关闭或切换会话后淡出，淡出期间保留原文。
  const presence = usePresence(safeMessage ? localizeFeedback(safeMessage, locale) : null);
  if (presence.rendered === null) return null;

  return (
    <div className="pwa-status-error pwa-presence" role="status" {...presenceProps(presence)}>
      <span>{presence.rendered}</span>
      <ActionIcon className="pwa-status-error-dismiss" type="button" onClick={onDismiss} aria-label={t.common.dismiss}>
        <X size={16} />
      </ActionIcon>
    </div>
  );
}
