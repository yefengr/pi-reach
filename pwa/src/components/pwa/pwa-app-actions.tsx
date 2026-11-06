import { ActionIcon, Button } from "@mantine/core";
import { ArrowDownToLine, CircleAlert, RefreshCw, X } from "lucide-react";
import { localizeFeedback, safeFeedbackMessage } from "@/lib/pwa/feedback-messages";
import { useI18n } from "@/lib/i18n";
import { observeWrappedText } from "@/lib/ui/wrapped-text";
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

// 正文换行时卡片圆角改为 16（ADR-20261105）。
const observeStatusErrorText = (text: HTMLSpanElement | null) => text ? observeWrappedText(text, ".pwa-status-error") : undefined;

export function PwaStatusError({ message, onDismiss }: StatusErrorProps) {
  const { t, locale } = useI18n();
  const safeMessage = safeFeedbackMessage(message);
  // 关闭或切换会话后淡出，淡出期间保留原文。
  const presence = usePresence(safeMessage ? localizeFeedback(safeMessage, locale) : null);
  if (presence.rendered === null) return null;

  return (
    <div className="pwa-status-error pwa-presence" role="status" {...presenceProps(presence)}>
      <CircleAlert className="pwa-status-error-icon" size={16} aria-hidden="true" />
      <span ref={observeStatusErrorText}>{presence.rendered}</span>
      <ActionIcon className="pwa-status-error-dismiss" type="button" onClick={onDismiss} aria-label={t.common.dismiss}>
        <X size={16} />
      </ActionIcon>
    </div>
  );
}
