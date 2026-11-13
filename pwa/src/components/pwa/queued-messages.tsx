import { useId, useLayoutEffect, useRef, useState } from "react";
import { ActionIcon, UnstyledButton } from "@mantine/core";
import { useI18n, type Messages } from "@/lib/i18n";
import { presenceProps, usePresence } from "./use-presence";
import { detachInPlace, useLeavingItems, withLeavingItems } from "./use-leaving-items";
import { FLIP_KEY_ATTRIBUTE, useFlipLayout } from "./use-flip-layout";
import { SMALL_SPINNER_SIZE } from "@/lib/ui/icon-metrics";
import { ArrowUp, ChevronDown, CircleAlert, Clock, LoaderCircle, Paperclip, Pencil, X } from "lucide-react";
import type { AttachmentDescriptor } from "@pi-reach/protocol/session";


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
    : item.pending ? <LoaderCircle className="pwa-spin" size={SMALL_SPINNER_SIZE} aria-hidden="true" />
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

function QueuedMessageRow({ item, index, numbered, isOnline, onInsert, onCancel, onDismissNotice, leaving = false }: QueuedMessageRowProps & { leaving?: boolean }) {
  const q = useI18n().t.queued;
  const rowRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (leaving) detachInPlace(rowRef.current); }, [leaving]);
  const description = queuedMessageDescription(item, index, q);
  const manageable = item.canManage && item.busy !== true && !item.dismissible;
  const attachmentCount = item.attachments?.length ?? 0;
  return <article ref={rowRef} className="pwa-queued-message" {...{ [FLIP_KEY_ATTRIBUTE]: item.id }} title={item.text || undefined} data-attention={item.attention ? "" : undefined}
    {...(leaving ? { "data-presence": "leaving", inert: true, "aria-hidden": true } : {})}>
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
 * 排队消息抽屉：收在输入框卡片后方，出现时从卡片背后滑出，清空时滑回卡片背后再移除（高度一次到位）；同一面板内每条一行（序号、状态、单行正文、附件计数、操作），列表固定最大高度并在内部滚动。
 * 两条以上时首行为标题、计数与箭头组成的折叠按钮，折叠整段列表，按 0fr↔1fr 过渡高度；折叠期间列表 inert，
 * 有需要关注的条目（如插入未确认）时标题行显示告警图标。只有可操作的条目显示插入与撤回，未确认提示只保留关闭。
 */
export function QueuedMessages({ items: current, isOnline, onInsert, onCancel, onDismissNotice }: QueuedMessagesProps) {
  const { t } = useI18n();
  const q = t.queued;
  const [collapsed, setCollapsed] = useState(false);
  const bodyId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  // 清空后保留最后一批条目，随包裹层收拢沉回卡片背后（drawer-out）再移除；离开期间 inert，不可操作也不被播报。
  const presence = usePresence(current.length ? current : null, Object.is, { exit: "--pwa-duration-drawer-out" });
  const leavingRows = useLeavingItems(current);
  // 撤回或投递一条时其余行与抽屉上沿平滑补位；抽屉贴着卡片向上长，上沿随之过渡。
  const flip = useFlipLayout(sectionRef, { edge: true });
  const items = presence.rendered ?? [];
  const present = items.length > 0;
  // 抽屉在场之后才让新行单独淡入；与抽屉同时出现的行随抽屉滑出，不叠加第二层淡入。
  // 先读一次几何，让初始行在没有标记时完成首次样式计算，再加标记，@starting-style 不会作用于它们。
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!present || !section || section.hasAttribute("data-entered")) return;
    section.getBoundingClientRect();
    section.setAttribute("data-entered", "");
  }, [present]);
  if (items.length === 0) return null;
  const numbered = items.length > 1;
  // 只有一条时没有标题行，也就不提供折叠。
  const folded = numbered && collapsed;
  const attention = items.some((item) => item.attention);
  const rowProps = { numbered, isOnline, onInsert, onCancel, onDismissNotice };

  return <div className="pwa-composer-grow pwa-queued-messages-slot" {...presenceProps(presence)}><section ref={sectionRef} className="pwa-queued-messages" aria-label={q.title} {...presenceProps(presence)}>
    {flip}
    {numbered ? <h2 className="pwa-queued-messages-header" {...{ [FLIP_KEY_ATTRIBUTE]: "header" }}>
      <UnstyledButton className="pwa-queued-messages-toggle" type="button" aria-expanded={!folded} aria-controls={bodyId} onClick={() => setCollapsed((current) => !current)}>
        <span className="pwa-queued-messages-title">{q.title}</span>
        {folded && attention ? <CircleAlert className="pwa-queued-messages-attention" size={16} aria-hidden="true" /> : null}
        <span className="pwa-queued-messages-count" aria-hidden="true">{items.length}</span>
        <span className="pwa-sr-only">{q.count(items.length)}</span>
        <ChevronDown className="pwa-queued-messages-chevron" size={16} aria-hidden="true" />
      </UnstyledButton>
    </h2> : null}
    <div id={bodyId} className="pwa-queued-messages-body" data-open={folded ? undefined : ""}>
      <div className="pwa-queued-messages-body-inner" inert={folded ? true : undefined}>
        <div className="pwa-queued-message-list">
          {withLeavingItems(items, presence.leaving ? [] : leavingRows).map(({ item, index, leaving }) =>
            <QueuedMessageRow key={item.id} item={item} index={index} leaving={leaving} {...rowProps} />)}
        </div>
      </div>
    </div>
  </section></div>;
}
