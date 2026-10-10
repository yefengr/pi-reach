import { useMemo, type RefObject } from "react";
import { Button } from "@mantine/core";
import { CircleAlert } from "lucide-react";
import { AssistantBlocks, MarkdownContent, ThinkingContent } from "./timeline-content";
import { ConversationTimeline } from "./conversation-timeline";
import { useTimelineEnterFade } from "./use-timeline-enter-fade";
import "./timeline-reconnect.css";
import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelinePending, TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { useI18n, type Messages } from "@/lib/i18n";
import type { TimelineReconnectPhase } from "@/lib/pwa/use-live-timeline";
import { runCompletions } from "@/lib/pwa/run-completion";
import { attachmentMessageKey, projectAttachmentMetadata, type TimelineAttachmentProjection } from "@/lib/pwa/timeline-attachments";
import { publishedFileFromEvent, type AttachmentMetadata } from "@pi-reach/protocol/session";
import { PublishedFile, type PublishedFileRead } from "./published-file";
import { AttachmentCards, readonlyAttachmentItems } from "./attachment-cards";

type MessageListProps = {
  items: TimelineViewItem[];
  hasEarlier: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  listRef: RefObject<HTMLDivElement | null>;
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
  onScroll: (nearBottom: boolean) => void;
  onRetryUnknown?: (clientRequestId: string) => void;
  onCancelQueued?: (clientRequestId: string) => void;
  isLive?: boolean;
  /** 当前源会话断线仍可显示已获取内容；只读历史不借用远程缓存。 */
  fileSourceCurrent?: boolean;
  /** 新会话无消息时在提示下方显示的上下文，如「目录 · 模型 · 思考级别」。 */
  emptyContext?: string | null;
  onReadingChange?: (reading: boolean) => void;
  reconnectPhase?: TimelineReconnectPhase;
  /** 时间线开头居中的一行说明，如「Pi 已切换到新会话」。 */
  topNotice?: string | null;
  /** 打开会话、尚无内容时为 true；列表保持挂载，骨架行按 skeletonVisible 显示。 */
  loading?: boolean;
  skeletonVisible?: boolean;
  /** 在线 Pi 是否正在运行（整次运行）；历史阅读恒为 false。 */
  running?: boolean;
};

function blockText(event: TimelineEvent | TimelinePartial): string {
  if ("blocks" in event && event.blocks) return event.blocks.map((block) => ("text" in block ? block.text : "")).join("\n");
  return "delta" in event && event.delta ? event.delta : "";
}

/** 发送方只为读屏标出；用户消息靠右、轻底，不显示时间。 */
function userScreenReaderLabel(event: Extract<TimelineEvent, { kind: "user" }>, t: Messages["timeline"]): string {
  return event.origin === "extension" ? t.srRemote : t.srYou;
}

function eventText(event: TimelineEvent): string {
  if (event.kind === "user" || event.kind === "assistant") return blockText(event);
  if (event.kind === "provider_error") return event.message;
  if (event.kind === "compaction") return typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
  if (event.kind === "branch_summary") return typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
  return "";
}

function UserBlocks({ event }: { event: Extract<TimelineEvent, { kind: "user" }> }) {
  const { t, format } = useI18n();
  return <div className="pwa-user-blocks">{event.blocks.map((block, index) => block.type === "text" ? <p key={index}>{block.text}</p> : "omitted" in block ? <div className="pwa-image-omitted" key={index}>{t.timeline.imageOmitted(block.mime_type, format.number(block.byte_length))}</div> : <img className="pwa-message-image" key={index} src={`data:${block.mime_type};base64,${block.data}`} alt={t.timeline.attachmentAlt(index + 1)} />)}</div>;
}

function EventCard({ event, metadata }: { event: Exclude<TimelineEvent, { kind: "tool" }>; metadata?: AttachmentMetadata }) {
  const { t } = useI18n();
  if (event.kind === "user") return <article className="pwa-message user"><span className="pwa-sr-only">{userScreenReaderLabel(event, t.timeline)}</span>{metadata ? <div className="pwa-user-blocks">{metadata.text ? <p>{metadata.text}</p> : null}<AttachmentCards items={readonlyAttachmentItems(metadata.attachments)} /></div> : <UserBlocks event={event} />}</article>;
  if (event.kind === "assistant") return <article className="pwa-message assistant"><span className="pwa-sr-only">{t.timeline.srPi}</span><AssistantBlocks blocks={event.blocks} /></article>;
  // 模型服务错误留在原位：错误色轻底、图标与文字说明。
  if (event.kind === "provider_error") return <article className="pwa-message provider_error"><p className="pwa-message-status"><CircleAlert size={16} aria-hidden="true" />{t.timeline.providerError}</p><MarkdownContent text={event.message} /></article>;
  return <article className={`pwa-message ${event.kind}`}><p className="pwa-message-status">{t.timeline.system}</p><p>{eventText(event)}</p></article>;
}

/** 待发送消息：气泡下方以 12px secondary 状态行显示「发送中」或「投递状态未知」＋「重试」。 */
function PendingCard({ pending, onRetryUnknown, onCancelQueued }: { pending: TimelinePending; onRetryUnknown?: (clientRequestId: string) => void; onCancelQueued?: (clientRequestId: string) => void }) {
  const { t } = useI18n();
  const unknown = pending.delivery === "unknown_delivery";
  const queued = pending.delivery === "accepted" && pending.messageId === undefined && pending.cancelable === true;
  const status = unknown ? t.timeline.deliveryUnknown : queued ? t.timeline.queued : t.timeline.deliverySending;
  return <div className="pwa-pending">
    <article className="pwa-message user pending"><span className="pwa-sr-only">{t.timeline.srYou}</span><div className="pwa-user-blocks">{pending.text ? <p>{pending.text}</p> : null}{pending.images?.map((image, index) => <img className="pwa-message-image" key={index} src={`data:${image.mime};base64,${image.data}`} alt={t.timeline.attachmentAlt(index + 1)} />)}{pending.attachments?.length ? <AttachmentCards items={readonlyAttachmentItems(pending.attachments)} /> : null}</div></article>
    <p className="pwa-delivery-status" role="status">
      <span>{status}</span>
      {unknown && onRetryUnknown ? <Button className="pwa-delivery-action" variant="transparent" color="piReach" size="compact-sm" type="button" onClick={() => onRetryUnknown(pending.clientRequestId)} aria-label={t.timeline.retryDelivery}>{t.common.retry}</Button> : null}
      {queued && onCancelQueued ? <Button className="pwa-delivery-action" variant="transparent" color="piReach" size="compact-sm" type="button" onClick={() => onCancelQueued(pending.clientRequestId)} aria-label={t.timeline.cancelQueued}>{t.common.cancel}</Button> : null}
    </p>
  </div>;
}

function PartialCard({ partial }: { partial: Exclude<TimelinePartial, { kind: "tool" }> }) {
  const { t } = useI18n();
  const text = blockText(partial);
  if (partial.kind === "thinking") return <ThinkingContent text={text} streaming />;
  return <article className="pwa-message assistant partial"><span className="pwa-sr-only">{t.timeline.srPi}</span>{partial.blocks ? <AssistantBlocks blocks={partial.blocks} streaming /> : text.trim() ? <div className="pwa-stream-text">{text}</div> : null}</article>;
}

function renderItem(item: TimelineViewItem, onRetryUnknown: MessageListProps["onRetryUnknown"], onCancelQueued: MessageListProps["onCancelQueued"], projection: TimelineAttachmentProjection, live: boolean, onRead: PublishedFileRead) {
  if (item.kind === "event") {
    const file = publishedFileFromEvent(item.event);
    if (file) return <PublishedFile key={item.event.event_id} file={file} live={live} onRead={onRead} />;
  }
  if (item.kind === "pending") return <PendingCard pending={item} key={item.id} onRetryUnknown={onRetryUnknown} onCancelQueued={onCancelQueued} />;
  const value = item.kind === "event" ? item.event : item.partial;
  // projectTimeline 将全部工具投影为 ToolEntry，由 ConversationTimeline 提供详情入口。
  if (value.kind === "tool") return null;
  if (item.kind === "event" && item.event.kind !== "tool") return <EventCard event={item.event} key={item.event.event_id} metadata={item.event.kind === "user" ? projection.messages.get(attachmentMessageKey(item.event.session_id, item.event.message_id)) : undefined} />;
  if (item.kind === "partial" && item.partial.kind !== "tool") return <PartialCard partial={item.partial} key={item.partial.partial_id} />;
  return null;
}

export function MessageList({ items, hasEarlier, loadingEarlier, onLoadEarlier, listRef, bottomSentinelRef, onScroll, onRetryUnknown, onCancelQueued, isLive = true, fileSourceCurrent = isLive, emptyContext = null, onReadingChange, reconnectPhase = null, topNotice = null, loading = false, skeletonVisible = false, running = false }: MessageListProps) {
  const { t } = useI18n();
  // 必须读取完整集合，不能在隐藏 custom 后丢失历史附件关联。
  const attachmentProjection = useMemo(() => projectAttachmentMetadata(items), [items]);
  // 仅合法发布记录可见，继续隐藏未知 custom；发布记录也是工具摘要的边界。
  const visibleItems = items.filter((item) => item.kind !== "event" || (item.event.kind !== "run_end" && (item.event.kind !== "custom" || publishedFileFromEvent(item.event) !== null) && (item.event.kind !== "assistant" || item.event.blocks.some((block) => block.text.trim()))));
  const liveRunning = isLive && running;
  const loadingEmpty = visibleItems.length === 0 && loading;
  useTimelineEnterFade(listRef, visibleItems.length === 0, loading);
  const completions = useMemo(() => runCompletions(
    items.flatMap((item) => item.kind === "event" ? [item.event] : []),
  ), [items]);
  return <div className="pwa-message-list" data-reconnect-phase={reconnectPhase ?? undefined} ref={listRef} tabIndex={-1} onScroll={(event) => {
    const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
    onScroll(scrollHeight - scrollTop - clientHeight <= 32);
  }}>
    {hasEarlier && !loadingEmpty ? <Button variant="default" className="pwa-earlier-button" type="button" onClick={onLoadEarlier} disabled={loadingEarlier || !isLive}>{loadingEarlier ? t.timeline.loadingRecords : t.timeline.loadMore}</Button> : null}
    {topNotice ? <p className="pwa-timeline-notice" role="status">{topNotice}</p> : null}
    {loadingEmpty ? <div className="pwa-skeleton-rows" aria-busy="true"><span className="pwa-sr-only" role="status">{t.workspace.loading}</span>{skeletonVisible ? <><span className="pwa-skeleton pwa-skeleton-user" aria-hidden="true" /><span className="pwa-skeleton pwa-skeleton-line" aria-hidden="true" /><span className="pwa-skeleton pwa-skeleton-line pwa-skeleton-short" aria-hidden="true" /></> : null}</div> : visibleItems.length === 0 ? <div className="pwa-chat-empty"><p>{isLive ? t.workspace.newSessionHint : t.timeline.emptyHistory}</p>{isLive && emptyContext ? <p className="pwa-chat-empty-context">{emptyContext}</p> : null}</div> : <ConversationTimeline items={visibleItems} live={isLive} completions={completions} running={liveRunning} listRef={listRef} onReadingChange={onReadingChange} renderRecord={(item, onRead) => renderItem(item, isLive ? onRetryUnknown : undefined, isLive ? onCancelQueued : undefined, attachmentProjection, fileSourceCurrent, onRead)} />}
    <div ref={bottomSentinelRef} aria-hidden="true" className="pwa-bottom-sentinel" />
  </div>;
}
