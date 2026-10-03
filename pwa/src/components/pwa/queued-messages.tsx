import { ActionIcon } from "@mantine/core";
import { useI18n, type Messages } from "@/lib/i18n";
import { CornerDownLeft, X } from "lucide-react";
import type { AttachmentDescriptor } from "@pi-reach/protocol/session";
import { AttachmentCards, readonlyAttachmentItems } from "./attachment-cards";

export type QueuedMessageView = {
  id: string;
  text: string;
  images?: { data: string; mime: string }[];
  attachments?: readonly AttachmentDescriptor[];
  status: string;
  notice?: string;
  dismissible?: boolean;
  canManage: boolean;
  busy?: boolean;
};

type QueuedMessagesProps = {
  items: QueuedMessageView[];
  isOnline: boolean;
  onInsert: (id: string) => void;
  onCancel: (id: string) => void;
  onDismissNotice?: (id: string) => void;
};

function queuedMessageDescription(item: QueuedMessageView, index: number, t: Messages["queued"]) {
  return t.description(index + 1, item.text.trim());
}

/** 排队消息：每条一行（状态、单行正文、插入与取消图标按钮），两条以上才显示标题与计数；投递提示在下方补一行说明。 */
export function QueuedMessages({ items, isOnline, onInsert, onCancel, onDismissNotice }: QueuedMessagesProps) {
  const { t } = useI18n();
  const q = t.queued;
  if (items.length === 0) return null;

  return <section className="pwa-queued-messages" aria-label={q.title}>
    {items.length > 1 ? <header className="pwa-queued-messages-header">
      <h2>{q.title}</h2>
      <span className="pwa-queued-messages-count" aria-label={q.count(items.length)}>{items.length}</span>
    </header> : null}
    <div className="pwa-queued-message-list">
      {items.map((item, index) => {
        const disabled = !isOnline || !item.canManage || item.busy === true;
        const description = queuedMessageDescription(item, index, q);
        return <article className="pwa-queued-message" key={item.id} title={item.text || undefined}>
          {item.images?.length ? <div className="pwa-queued-message-images">
            {item.images.map((image, imageIndex) => <img key={`${item.id}-${imageIndex}`} src={`data:${image.mime};base64,${image.data}`} alt={q.imageAlt(index + 1, imageIndex + 1)} />)}
          </div> : null}
          <div className="pwa-queued-message-copy">
            <div className="pwa-queued-message-line">
              <span className="pwa-queued-message-status">{item.status}</span>
              {item.text ? <p className="pwa-queued-message-text">{item.text}</p> : null}
            </div>
            {item.attachments?.length ? <AttachmentCards items={readonlyAttachmentItems(item.attachments)} /> : null}
            {item.notice ? <p className="pwa-queued-message-notice">{item.notice}</p> : null}
          </div>
          <div className="pwa-queued-message-actions">
            <ActionIcon className="pwa-queued-message-insert" type="button" disabled={disabled} onClick={() => onInsert(item.id)} aria-label={q.insertLabel(description)} title={q.insertLabel(description)}><CornerDownLeft size={20} /></ActionIcon>
            <ActionIcon className="pwa-queued-message-cancel" type="button" disabled={disabled} onClick={() => onCancel(item.id)} aria-label={q.cancelLabel(description)} title={q.cancelLabel(description)}><X size={20} /></ActionIcon>
            {item.dismissible && onDismissNotice ? <ActionIcon className="pwa-queued-message-dismiss" type="button" onClick={() => onDismissNotice(item.id)} aria-label={q.dismissLabel(description)} title={q.dismissLabel(description)}><X size={20} /></ActionIcon> : null}
          </div>
        </article>;
      })}
    </div>
  </section>;
}
