import { useState } from "react";
import { ActionIcon, Button } from "@mantine/core";
import { RefreshCw } from "lucide-react";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelinePending } from "@/lib/pwa/timeline-runtime";
import type { AttachmentMetadata } from "@pi-reach/protocol/session";
import { useI18n, type Messages } from "@/lib/i18n";
import { AttachmentCards, readonlyAttachmentItems } from "./attachment-cards";

type UserEvent = Extract<TimelineEvent, { kind: "user" }>;
type Props = {
  value: TimelinePending | UserEvent;
  metadata?: AttachmentMetadata;
  entering: boolean;
  timelineKey: string;
  onRetryFailed?: (id: string) => void;
  onCheckStatus?: (id: string) => void;
  onCancelQueued?: (id: string) => void;
  canCheckStatus?: boolean;
};

/** 未知原因码统一退到 unavailable，不为未映射的代码留空行。 */
function failureReason(reasons: Messages["timeline"]["deliveryFailed"], code: string): string {
  return code === "queue_full" || code === "transport_unavailable" || code === "invalid_target" ? reasons[code] : reasons.unavailable;
}

/** pending 与正式记录共用同一节点；确认只替换内容与状态，不重启动效。 */
export function UserMessage({ value, metadata, entering, timelineKey, onRetryFailed, onCheckStatus, onCancelQueued, canCheckStatus = true }: Props) {
  const { t, format } = useI18n();
  // 入场资格仅在气泡创建时确定，离线／重连不能撤下再添加动画 class。
  const [animateEntrance] = useState(entering);
  const pending = value.kind === "pending" ? value : null;
  const event = value.kind === "user" ? value : null;
  const failure = pending?.delivery === "failed" ? pending.deliveryFailure : undefined;
  const cancelled = pending?.delivery === "cancelled";
  const scopeInvalid = pending?.scopeInvalid === true;
  const unknown = pending?.delivery === "unknown_delivery";
  const queued = !scopeInvalid && pending?.delivery === "accepted" && pending.messageId === undefined && pending.cancelable === true;
  // 普通 pending／received／accepted 不占状态行，异常才在气泡下方按正常文档流排布。
  const status = scopeInvalid ? t.timeline.deliveryTargetUnavailable
    : cancelled ? t.timeline.cancelledKept
      : failure ? failure.code === "invalid_target" && pending?.attachments?.length
        ? t.timeline.deliveryAttachmentUnavailable : failureReason(t.timeline.deliveryFailed, failure.code)
        : unknown ? t.timeline.deliveryUnknown : queued ? t.timeline.queued : null;
  const querying = pending?.statusQuery !== undefined;
  // 旧扩展无法回答查询，核对说明取代无效点击；离线时说明恢复连接后可核对。
  const unsupported = unknown && pending?.statusQueryUnsupported === true;
  const checkable = !scopeInvalid && unknown && !unsupported && !querying && canCheckStatus && onCheckStatus !== undefined;
  const offlineUnknown = !scopeInvalid && unknown && !unsupported && !canCheckStatus;
  const retryable = !scopeInvalid && failure?.retryable === true && onRetryFailed !== undefined;
  const attachments = pending?.attachments ?? metadata?.attachments;
  const text = pending?.text ?? metadata?.text;
  const label = event?.origin === "extension" ? t.timeline.srRemote : t.timeline.srYou;
  return <div className={`pwa-user-row${pending ? " pwa-pending" : ""}`} data-viewport-row={timelineKey}>
    <div className="pwa-user-bubble-frame">
    <article className={`pwa-message user${pending ? " pending" : ""}${animateEntrance ? " pwa-user-message-in" : ""}`}>
      <span className="pwa-sr-only">{label}</span>
      <div className="pwa-user-blocks">
        {pending || metadata ? <>
          {text ? <p>{text}</p> : null}
          {pending?.images?.map((image, index) => <img className="pwa-message-image" key={index} src={`data:${image.mime};base64,${image.data}`} alt={t.timeline.attachmentAlt(index + 1)} />)}
          {attachments?.length ? <AttachmentCards items={readonlyAttachmentItems(attachments)} /> : null}
        </> : event?.blocks.map((block, index) => block.type === "text" ? <p key={index}>{block.text}</p> : "omitted" in block ? <div className="pwa-image-omitted" key={index}>{t.timeline.imageOmitted(block.mime_type, format.number(block.byte_length))}</div> : <img className="pwa-message-image" key={index} src={`data:${block.mime_type};base64,${block.data}`} alt={t.timeline.attachmentAlt(index + 1)} />)}
      </div>
    </article>
    </div>
    {pending && status ? <p className="pwa-delivery-status" role="status" data-delivery={pending.delivery}>
      <span>{status}</span>
      {unknown && pending.statusQueryUnsupported ? <span>{t.timeline.deliveryUnsupported}</span> : null}
      {offlineUnknown ? <span>{t.timeline.deliveryOffline}</span> : null}
      {checkable ? <ActionIcon className="pwa-delivery-action" type="button" onClick={() => onCheckStatus(pending.clientRequestId)} aria-label={t.timeline.deliveryCheck} title={t.timeline.deliveryCheck}><RefreshCw size={16} aria-hidden="true" /></ActionIcon> : null}
      {unknown && querying && !unsupported && canCheckStatus ? <ActionIcon className="pwa-delivery-action" type="button" disabled aria-label={t.timeline.deliveryCheck} title={t.timeline.deliveryCheck}><RefreshCw size={16} aria-hidden="true" /></ActionIcon> : null}
      {retryable ? <ActionIcon className="pwa-delivery-action" type="button" onClick={() => onRetryFailed(pending.clientRequestId)} aria-label={t.timeline.deliveryRetry} title={t.timeline.deliveryRetry}><RefreshCw size={16} aria-hidden="true" /></ActionIcon> : null}
      {queued && onCancelQueued ? <Button className="pwa-delivery-action" variant="transparent" color="piReach" size="compact-sm" type="button" onClick={() => onCancelQueued(pending.clientRequestId)} aria-label={t.timeline.cancelQueued}>{t.common.cancel}</Button> : null}
    </p> : null}
  </div>;
}
