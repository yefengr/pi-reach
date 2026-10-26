import { useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { Button } from "@mantine/core";
import { LoaderCircle } from "lucide-react";
import { AssistantBlocks, ThinkingContent } from "./timeline-content";
import { CompactionNoticeRow, CompactionStatus, ConversationTimeline, GapNotice } from "./conversation-timeline";
import { useTimelineEnterFade } from "./use-timeline-enter-fade";
import "./timeline-reconnect.css";
import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { useI18n } from "@/lib/i18n";
import type { TimelineReconnectPhase } from "@/lib/pwa/use-live-timeline";
import { runCompletions } from "@/lib/pwa/run-completion";
import { attachmentMessageKey, projectAttachmentMetadata, type TimelineAttachmentProjection } from "@/lib/pwa/timeline-attachments";
import { publishedFileFromEvent, type AttachmentMetadata } from "@pi-reach/protocol/session";
import { PublishedFile, type PublishedFileRead } from "./published-file";
import { UserMessage } from "./user-message";
import { useAutoLoadEarlier } from "./use-auto-load-earlier";
import { useDelayedVisibility } from "./use-delayed-visibility";
import { TIMELINE_GEOMETRY_EVENT } from "@/lib/pwa/use-timeline-viewport";
import type { CompactionNotice } from "@/lib/pwa/operation-feedback";
import { SMALL_SPINNER_SIZE, SMALL_SPINNER_STROKE } from "@/lib/ui/icon-metrics";

const NO_NOTICES: readonly CompactionNotice[] = [];

type MessageListProps = {
  items: TimelineViewItem[];
  hasEarlier: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  /** 上次向前加载失败：停止自动加载，改为显示重试，避免失败后连续重试。 */
  loadEarlierFailed?: boolean;
  /** 是否允许接近顶部时自动加载；在线会话仍跟随最新输出时为 false，避免打开时立即向前加载。 */
  autoLoadEarlier?: boolean;
  /** 这些正式事件之前缺少记录（只读历史中未保存的区间），在其前方标出。 */
  gapBefore?: ReadonlySet<string>;
  listRef: RefObject<HTMLDivElement | null>;
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
  onScroll: (nearBottom: boolean) => void;
  onRetryFailed?: (clientRequestId: string) => void;
  onCheckStatus?: (clientRequestId: string) => void;
  onCancelQueued?: (clientRequestId: string) => void;
  /** 离线时保留未知提示但不提供无效核对入口。 */
  canCheckStatus?: boolean;
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
  /** 更早的记录已在本地（只读历史），不依赖实时连接即可展开。 */
  earlierLocal?: boolean;
  /** 附件投影读取的完整集合；只读历史分页只限制渲染的记录，附件元数据可能落在窗口之外。默认等于 items。 */
  projectionItems?: TimelineViewItem[];
  skeletonVisible?: boolean;
  /** 在线 Pi 是否正在运行（整次运行）；历史阅读恒为 false。 */
  running?: boolean;
  /** 压缩上下文进行中；历史阅读恒为 false。 */
  compacting?: boolean;
  /** 压缩终态提示，按 afterSeq 插在对应记录之后；不写入历史。 */
  notices?: readonly CompactionNotice[];
};

function blockText(event: TimelineEvent | TimelinePartial): string {
  if ("blocks" in event && event.blocks) return event.blocks.map((block) => ("text" in block ? block.text : "")).join("\n");
  return "delta" in event && event.delta ? event.delta : "";
}

/** 隐藏未知 custom、run_end 与纯空白正文；保留空思考记录，由投影合并为静态痕迹。 */
function isVisibleItem(item: TimelineViewItem): boolean {
  if (item.kind !== "event") return true;
  const event = item.event;
  if (event.kind === "run_end") return false;
  if (event.kind === "custom") return publishedFileFromEvent(event) !== null;
  return event.kind !== "assistant" || event.blocks.some((block) => block.type === "thinking" || block.text.trim());
}

/** 缺口标在隐藏记录上时顺延到其后第一条可见记录；其后没有可见记录时标在时间线末尾，过滤后提示不丢失。 */
function visibleGaps(items: readonly TimelineViewItem[], gapBefore: ReadonlySet<string> | undefined): { before?: ReadonlySet<string>; atEnd: boolean } {
  if (!gapBefore || gapBefore.size === 0) return { before: gapBefore, atEnd: false };
  const before = new Set<string>();
  let pending = false;
  for (const item of items) {
    if (item.kind === "event" && gapBefore.has(item.event.event_id)) pending = true;
    if (!pending || !isVisibleItem(item) || item.kind !== "event") continue;
    before.add(item.event.event_id);
    pending = false;
  }
  return { before, atEnd: pending };
}

function EventCard({ event, metadata, timelineKey }: { event: Exclude<TimelineEvent, { kind: "tool" }>; metadata?: AttachmentMetadata; timelineKey: string }) {
  const { t } = useI18n();
  if (event.kind === "user") return <UserMessage value={event} metadata={metadata} entering={false} timelineKey={timelineKey} />;
  if (event.kind === "assistant") return <article className="pwa-message assistant" data-viewport-row={timelineKey}><span className="pwa-sr-only">{t.timeline.srPi}</span><AssistantBlocks blocks={event.blocks} /></article>;
  // 摘要和服务错误由 ConversationTimeline 提供安全阅读入口，不在会话中铺开正文。
  return null;
}

function PartialCard({ partial, timelineKey }: { partial: Exclude<TimelinePartial, { kind: "tool" }>; timelineKey: string }) {
  const { t } = useI18n();
  const text = blockText(partial);
  if (partial.kind === "thinking") return <ThinkingContent text={text} streaming timelineKey={timelineKey} />;
  return <article className="pwa-message assistant partial" data-viewport-row={timelineKey}><span className="pwa-sr-only">{t.timeline.srPi}</span>{partial.blocks ? <AssistantBlocks blocks={partial.blocks} streaming /> : text.trim() ? <div className="pwa-stream-text">{text}</div> : null}</article>;
}

function renderItem(item: TimelineViewItem, onRetryFailed: MessageListProps["onRetryFailed"], onCheckStatus: MessageListProps["onCheckStatus"], onCancelQueued: MessageListProps["onCancelQueued"], canCheckStatus: boolean, projection: TimelineAttachmentProjection, live: boolean, onRead: PublishedFileRead, userMessageIn: boolean, timelineKey: string) {
  if (item.kind === "event") {
    const file = publishedFileFromEvent(item.event);
    if (file) return <PublishedFile key={item.event.event_id} file={file} live={live} onRead={onRead} timelineKey={timelineKey} />;
  }
  if (item.kind === "pending") return <UserMessage value={item} timelineKey={timelineKey} entering={userMessageIn} onRetryFailed={onRetryFailed} onCheckStatus={onCheckStatus} onCancelQueued={onCancelQueued} canCheckStatus={canCheckStatus} />;
  if (item.kind === "event" && item.event.kind === "user") return <UserMessage value={item.event} timelineKey={timelineKey} entering={userMessageIn} metadata={projection.messages.get(attachmentMessageKey(item.event.session_id, item.event.message_id))} />;
  const value = item.kind === "event" ? item.event : item.partial;
  // projectTimeline 将全部工具投影为 ToolEntry，由 ConversationTimeline 提供详情入口。
  if (value.kind === "tool") return null;
  if (item.kind === "event" && item.event.kind !== "tool") return <EventCard event={item.event} key={item.event.event_id} timelineKey={timelineKey} />;
  if (item.kind === "partial" && item.partial.kind !== "tool") return <PartialCard partial={item.partial} key={item.partial.partial_id} timelineKey={timelineKey} />;
  return null;
}

/** 顶部的更早记录入口：加载中显示动画，失败显示重试，离线只读说明；空闲时保留按钮供键盘和无法自动触发时使用。 */
function EarlierRecords({ loading, failed, offline, onLoad }: { loading: boolean; failed: boolean; offline: boolean; onLoad: () => void }) {
  const { t } = useI18n();
  const loaderVisible = useDelayedVisibility(loading);
  // 离线时重试无法生效，连接说明优先于失败状态。
  if (offline) return <p className="pwa-earlier">{t.timeline.earlierOffline}</p>;
  if (failed && !loading) return <div className="pwa-earlier" role="status"><span>{t.timeline.loadEarlierFailed}</span><Button className="pwa-earlier-button" variant="transparent" size="compact-sm" type="button" onClick={onLoad} aria-label={t.timeline.retryEarlier}>{t.common.retry}</Button></div>;
  if (loading || loaderVisible) return <div className="pwa-earlier" aria-busy="true">
    <span className="pwa-sr-only" role="status">{t.timeline.loadingRecords}</span>
    {loaderVisible ? <span className="pwa-earlier-loading" aria-hidden="true"><LoaderCircle className="pwa-spin" size={SMALL_SPINNER_SIZE} strokeWidth={SMALL_SPINNER_STROKE} />{t.timeline.loadingRecords}</span> : null}
  </div>;
  return <div className="pwa-earlier"><Button variant="default" className="pwa-earlier-button" type="button" onClick={onLoad}>{t.timeline.loadMore}</Button></div>;
}

export function MessageList({ items, hasEarlier, loadingEarlier = false, onLoadEarlier, loadEarlierFailed = false, autoLoadEarlier = true, gapBefore, listRef, bottomSentinelRef, onScroll, onRetryFailed, onCheckStatus, onCancelQueued, canCheckStatus = true, isLive = true, fileSourceCurrent = isLive, emptyContext = null, earlierLocal = false, projectionItems = items, onReadingChange, reconnectPhase = null, topNotice = null, loading = false, skeletonVisible = false, running = false, compacting = false, notices = NO_NOTICES }: MessageListProps) {
  const { t } = useI18n();
  // 必须读取完整集合，不能在隐藏 custom 后丢失历史附件关联。
  const attachmentProjection = useMemo(() => projectAttachmentMetadata(projectionItems), [projectionItems]);
  const visibleItems = items.filter(isVisibleItem);
  const [visibility, setVisibility] = useState(() => ({ items, empty: visibleItems.length === 0, enterInitialPending: false }));
  let enterInitialPending = visibility.enterInitialPending;
  if (visibility.items !== items) {
    enterInitialPending = visibility.empty && visibleItems.length > 0;
    setVisibility({ items, empty: visibleItems.length === 0, enterInitialPending });
  }
  const gaps = useMemo(() => visibleGaps(items, gapBefore), [items, gapBefore]);
  const liveRunning = isLive && running;
  const liveCompacting = isLive && compacting;
  // 压缩行与终态提示不随 items 变化，尺寸感知不到它们的高度变化，需主动通知时间线重新贴底或恢复锚点。
  // 用提示 id 作为依赖，避免每次渲染的新数组触发重复贴底。
  const noticeKey = notices.map((notice) => notice.id).join("|");
  useLayoutEffect(() => {
    listRef.current?.dispatchEvent(new Event(TIMELINE_GEOMETRY_EVENT));
  }, [liveCompacting, noticeKey, listRef]);
  const loadingEmpty = visibleItems.length === 0 && loading;
  useTimelineEnterFade(listRef, visibleItems.length === 0, loading);
  const completions = useMemo(() => runCompletions(
    items.flatMap((item) => item.kind === "event" ? [item.event] : []),
  ), [items]);
  const earlierOffline = !isLive && !earlierLocal;
  const showEarlier = hasEarlier && !loadingEmpty;
  const checkAutoLoad = useAutoLoadEarlier({
    listRef,
    enabled: showEarlier && autoLoadEarlier && !loadingEarlier && !loadEarlierFailed && !earlierOffline && onLoadEarlier !== undefined,
    contentVersion: items,
    onLoad: () => onLoadEarlier?.(),
  });
  return <div className="pwa-message-list" data-reconnect-phase={reconnectPhase ?? undefined} ref={listRef} tabIndex={-1} onScroll={(event) => {
    const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
    onScroll(scrollHeight - scrollTop - clientHeight <= 32);
    checkAutoLoad();
  }}>
    {showEarlier ? <EarlierRecords loading={loadingEarlier} failed={loadEarlierFailed} offline={earlierOffline} onLoad={() => onLoadEarlier?.()} /> : null}
    {topNotice ? <p className="pwa-timeline-notice" role="status">{topNotice}</p> : null}
    {loadingEmpty ? <div className="pwa-skeleton-rows" aria-busy="true"><span className="pwa-sr-only" role="status">{t.workspace.loading}</span>{skeletonVisible ? <><span className="pwa-skeleton pwa-skeleton-user" aria-hidden="true" /><span className="pwa-skeleton pwa-skeleton-line" aria-hidden="true" /><span className="pwa-skeleton pwa-skeleton-line pwa-skeleton-short" aria-hidden="true" /></> : null}</div> : visibleItems.length === 0 ? <><div className="pwa-chat-empty"><p>{isLive ? t.workspace.newSessionHint : t.timeline.emptyHistory}</p>{isLive && emptyContext ? <p className="pwa-chat-empty-context">{emptyContext}</p> : null}</div>{gaps.atEnd ? <GapNotice /> : null}{notices.map((notice) => <CompactionNoticeRow key={notice.id} notice={notice} />)}{liveCompacting ? <CompactionStatus /> : null}</> : <ConversationTimeline items={visibleItems} live={isLive} enterInitialPending={enterInitialPending} gapBefore={gaps.before} gapAtEnd={gaps.atEnd} completions={completions} running={liveRunning} compacting={liveCompacting} notices={notices} listRef={listRef} onReadingChange={onReadingChange} renderRecord={(item, onRead, userMessageIn, timelineKey) => renderItem(item, isLive ? onRetryFailed : undefined, isLive ? onCheckStatus : undefined, isLive ? onCancelQueued : undefined, canCheckStatus && isLive, attachmentProjection, fileSourceCurrent, onRead, userMessageIn, timelineKey)} />}
    <div ref={bottomSentinelRef} aria-hidden="true" className="pwa-bottom-sentinel" />
  </div>;
}
