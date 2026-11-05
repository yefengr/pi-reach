import { useId, useState } from "react";
import { ActionIcon, Button } from "@mantine/core";
import { useI18n, type Messages } from "@/lib/i18n";
import { SMALL_SPINNER_SIZE, SMALL_SPINNER_STROKE } from "@/lib/ui/icon-metrics";
import { ArrowUp, ChevronDown, CircleAlert, Clock, LoaderCircle, Paperclip, Pencil, X } from "lucide-react";
import type { AttachmentDescriptor } from "@pi-reach/protocol/session";

/** 超过该条数时折叠其余排队消息，避免面板挤占对话区。 */
const COLLAPSED_QUEUE_LIMIT = 3;

export type QueuedMessageView = {
  id: string;
  text: string;
  images?: { data: string; mime: string }[];
  attachments?: readonly AttachmentDescriptor[];
  status: string;
  /** 仍在排队等待、可插入或撤回：只显示时钟，状态文字仅供读屏。 */
  waiting?: boolean;
  /** 插入、撤回或发送正在进行：状态前显示运行中旋转图标。 */
  pending?: boolean;
  notice?: string;
  /** 需要用户关注（如插入未确认）：告警图标，状态与说明用运行色，普通排队保持中性。 */
  attention?: boolean;
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

function QueuedMessageStatus({ item }: { item: QueuedMessageView }) {
  const icon = item.waiting ? <Clock size={16} aria-hidden="true" />
    : item.pending ? <LoaderCircle className="pwa-spin" size={SMALL_SPINNER_SIZE} strokeWidth={SMALL_SPINNER_STROKE} aria-hidden="true" />
      : item.attention ? <CircleAlert size={16} aria-hidden="true" />
        : null;
  return <span className="pwa-queued-message-status" data-pending={item.pending ? "" : undefined} title={item.waiting ? item.status : undefined}>
    {icon}<span className={item.waiting ? "pwa-sr-only" : undefined}>{item.status}</span>
  </span>;
}

type QueuedMessageRowProps = {
  item: QueuedMessageView;
  index: number;
  numbered: boolean;
  isOnline: boolean;
  onInsert: (id: string) => void;
  onCancel: (id: string) => void;
  onDismissNotice?: (id: string) => void;
};

function QueuedMessageRow({ item, index, numbered, isOnline, onInsert, onCancel, onDismissNotice }: QueuedMessageRowProps) {
  const q = useI18n().t.queued;
  const description = queuedMessageDescription(item, index, q);
  const manageable = item.canManage && item.busy !== true && !item.dismissible;
  const attachmentCount = item.attachments?.length ?? 0;
  return <article className="pwa-queued-message" title={item.text || undefined} data-attention={item.attention ? "" : undefined}>
    {numbered ? <span className="pwa-queued-message-index" aria-hidden="true">{index + 1}</span> : null}
    {item.images?.length ? <div className="pwa-queued-message-images">
      {item.images.map((image, imageIndex) => <img key={`${item.id}-${imageIndex}`} src={`data:${image.mime};base64,${image.data}`} alt={q.imageAlt(index + 1, imageIndex + 1)} />)}
    </div> : null}
    <div className="pwa-queued-message-copy">
      <div className="pwa-queued-message-line">
        <QueuedMessageStatus item={item} />
        {item.text ? <p className="pwa-queued-message-text">{item.text}</p> : null}
        {attachmentCount ? <span className="pwa-queued-message-attachments" title={q.attachmentCount(attachmentCount)}>
          <Paperclip size={16} aria-hidden="true" /><span aria-hidden="true">{attachmentCount}</span><span className="pwa-sr-only">{q.attachmentCount(attachmentCount)}</span>
        </span> : null}
      </div>
      {item.notice ? <p className="pwa-queued-message-notice">{item.notice}</p> : null}
    </div>
    <div className="pwa-queued-message-actions">
      {manageable ? <>
        <ActionIcon className="pwa-queued-message-insert" type="button" disabled={!isOnline} onClick={() => onInsert(item.id)} aria-label={q.insertLabel(description)} title={q.insertLabel(description)}><ArrowUp size={20} /></ActionIcon>
        <ActionIcon className="pwa-queued-message-cancel" type="button" disabled={!isOnline} onClick={() => onCancel(item.id)} aria-label={q.cancelLabel(description)} title={q.cancelLabel(description)}><Pencil size={20} /></ActionIcon>
      </> : null}
      {item.dismissible && onDismissNotice ? <ActionIcon className="pwa-queued-message-dismiss" type="button" onClick={() => onDismissNotice(item.id)} aria-label={q.dismissLabel(description)} title={q.dismissLabel(description)}><X size={20} /></ActionIcon> : null}
    </div>
  </article>;
}

/**
 * 排队消息抽屉：收在输入框卡片后方，同一面板内每条一行（序号、状态、单行正文、附件计数、操作），
 * 两条以上在首行显示标题与计数；超过上限时其余条目进入折叠区，展开与收起按 0fr↔1fr 过渡高度，
 * 收起期间折叠区 inert，不可聚焦也不被读屏读到。只有可操作的条目显示插入与撤回，未确认提示只保留关闭。
 */
export function QueuedMessages({ items, isOnline, onInsert, onCancel, onDismissNotice }: QueuedMessagesProps) {
  const { t } = useI18n();
  const q = t.queued;
  const [expanded, setExpanded] = useState(false);
  const overflowId = useId();
  if (items.length === 0) return null;
  const numbered = items.length > 1;
  const collapsible = items.length > COLLAPSED_QUEUE_LIMIT;
  const rowProps = { numbered, isOnline, onInsert, onCancel, onDismissNotice };
  const head = collapsible ? items.slice(0, COLLAPSED_QUEUE_LIMIT) : items;
  const rest = collapsible ? items.slice(COLLAPSED_QUEUE_LIMIT) : [];

  return <section className="pwa-queued-messages" aria-label={q.title}>
    <div className="pwa-queued-message-list">
      {numbered ? <header className="pwa-queued-messages-header">
        <h2>{q.title}</h2>
        <span className="pwa-queued-messages-count" aria-label={q.count(items.length)}>{items.length}</span>
      </header> : null}
      {head.map((item, index) => <QueuedMessageRow key={item.id} item={item} index={index} {...rowProps} />)}
      {collapsible ? <>
        <div id={overflowId} className="pwa-queued-messages-overflow" data-open={expanded ? "" : undefined}>
          <div className="pwa-queued-messages-overflow-inner" inert={expanded ? undefined : true}>
            {rest.map((item, index) => <QueuedMessageRow key={item.id} item={item} index={index + COLLAPSED_QUEUE_LIMIT} {...rowProps} />)}
          </div>
        </div>
        <Button className="pwa-queued-messages-more" variant="transparent" type="button" aria-expanded={expanded} aria-controls={overflowId}
          leftSection={<ChevronDown className="pwa-queued-messages-more-icon" size={16} aria-hidden="true" />} onClick={() => setExpanded((current) => !current)}>
          {expanded ? q.showLess : q.showMore(rest.length)}
        </Button>
      </> : null}
    </div>
  </section>;
}
