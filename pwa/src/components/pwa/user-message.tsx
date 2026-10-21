import { useState } from "react";
import { Button } from "@mantine/core";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelinePending } from "@/lib/pwa/timeline-runtime";
import type { AttachmentMetadata } from "@pi-reach/protocol/session";
import { useI18n } from "@/lib/i18n";
import { AttachmentCards, readonlyAttachmentItems } from "./attachment-cards";

type UserEvent = Extract<TimelineEvent, { kind: "user" }>;
type Props = {
  value: TimelinePending | UserEvent;
  metadata?: AttachmentMetadata;
  entering: boolean;
  onRetryUnknown?: (id: string) => void;
  onCancelQueued?: (id: string) => void;
};

/** pending 与正式记录共用同一节点；确认只替换内容与状态，不重启动效。 */
export function UserMessage({ value, metadata, entering, onRetryUnknown, onCancelQueued }: Props) {
  const { t, format } = useI18n();
  // 入场资格仅在气泡创建时确定，离线／重连不能撤下再添加动画 class。
  const [animateEntrance] = useState(entering);
  const pending = value.kind === "pending" ? value : null;
  const event = value.kind === "user" ? value : null;
  const unknown = pending?.delivery === "unknown_delivery";
  const queued = pending?.delivery === "accepted" && pending.messageId === undefined && pending.cancelable === true;
  const status = unknown ? t.timeline.deliveryUnknown : queued ? t.timeline.queued : t.timeline.deliverySending;
  const attachments = pending?.attachments ?? metadata?.attachments;
  const text = pending?.text ?? metadata?.text;
  const label = event?.origin === "extension" ? t.timeline.srRemote : t.timeline.srYou;
  return <div className={`pwa-user-row${pending ? " pwa-pending" : ""}${pending && !unknown && !queued ? " pwa-pending-short" : ""}`}>
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
    {pending ? <p className="pwa-delivery-status" role="status">
      <span>{status}</span>
      {unknown && onRetryUnknown ? <Button className="pwa-delivery-action" variant="transparent" color="piReach" size="compact-sm" type="button" onClick={() => onRetryUnknown(pending.clientRequestId)} aria-label={t.timeline.retryDelivery}>{t.common.retry}</Button> : null}
      {queued && onCancelQueued ? <Button className="pwa-delivery-action" variant="transparent" color="piReach" size="compact-sm" type="button" onClick={() => onCancelQueued(pending.clientRequestId)} aria-label={t.timeline.cancelQueued}>{t.common.cancel}</Button> : null}
    </p> : null}
  </div>;
}
