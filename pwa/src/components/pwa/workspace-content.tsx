import { useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { CopyButton } from "@/components/pwa/copy-button";
import { Button } from "@mantine/core";
import { ChevronRight, Computer, History, Link2, Radio } from "lucide-react";
import { MessageList } from "@/components/pwa/message-list";
import { ReadOnlyComposer } from "@/components/pwa/message-composer";
import { OnlinePiRow } from "@/components/pwa/workspace-view";
import type { PwaEndpointRecord } from "@/lib/pwa/db";
import type { ThinkingLevel } from "@/lib/pi-reach/types";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { TIMELINE_PAGE_SIZE } from "@/lib/pwa/timeline-history-loader";
import { TIMELINE_RECENT_LIMIT } from "@/lib/pwa/timeline-reconnect";
import { useI18n } from "@/lib/i18n";
import { useDelayedVisibility } from "./use-delayed-visibility";

export { useDelayedVisibility };

const PAIR_COMMAND = "/pi-reach pair";

export function LiveWorkspace({ timeline, footer }: { timeline: ReactNode; footer: ReactNode }) {
  return <>
    {timeline}
    <div className="pwa-chat-footer">{footer}</div>
  </>;
}

/** 切回只读历史时恢复的阅读位置；滚动位置依赖当时已展开的记录数，两者一起保存。 */
export type HistoryRestore = { scrollTop: number; visibleCount: number };

type HistoryWorkspaceProps = {
  items: TimelineViewItem[];
  /** 正在读取本地记录；读完之前不把空列表当作「没有记录」。 */
  loading?: boolean;
  restore?: HistoryRestore | null;
  /** 供离开时保存阅读位置读取当前已展开的记录数。 */
  visibleCountRef?: MutableRefObject<number>;
  listRef: RefObject<HTMLDivElement | null>;
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
  /** 该 Pi 最后已知的模型与思考级别，只读输入区按在线样式显示。 */
  modelName?: string | null;
  thinking?: ThinkingLevel;
};

/** 本地记录按序号排列后的完整性：首条之前和中间缺少的区间都未保存在此浏览器。 */
function savedRangeGaps(items: readonly TimelineViewItem[]): { gapBefore: Set<string>; missingStart: boolean } {
  const gapBefore = new Set<string>();
  let previous: number | null = null;
  let missingStart = false;
  for (const item of items) {
    if (item.kind !== "event" || item.event.event_seq === undefined) continue;
    const sequence = item.event.event_seq;
    if (previous === null) missingStart = sequence > 1;
    else if (sequence > previous + 1) gapBefore.add(item.event.event_id);
    previous = sequence;
  }
  return { gapBefore, missingStart };
}

/** 长历史先渲染最近一段，接近顶部时按页向前展开，避免一次渲染整个会话卡住界面；交互与在线会话的向前加载一致。 */
export function HistoryWorkspace({ items, loading = false, restore = null, visibleCountRef, listRef, bottomSentinelRef, modelName = null, thinking = "off" }: HistoryWorkspaceProps) {
  const { t } = useI18n();
  const [visibleCount, setVisibleCount] = useState(() => Math.max(restore?.visibleCount ?? 0, TIMELINE_RECENT_LIMIT));
  const visibleItems = useMemo(() => items.slice(-visibleCount), [items, visibleCount]);
  const { gapBefore, missingStart } = useMemo(() => savedRangeGaps(items), [items]);
  const hasEarlier = items.length > visibleCount;
  const skeletonVisible = useDelayedVisibility(loading);
  const positionedRef = useRef(false);
  const prependAnchorRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (visibleCountRef) visibleCountRef.current = visibleCount;
  }, [visibleCount, visibleCountRef]);
  useLayoutEffect(() => {
    // 首次打开停在底部最新内容；同一次访问中切回时按当时展开的范围恢复离开时的位置。
    const list = listRef.current;
    if (positionedRef.current || !list || items.length === 0) return;
    positionedRef.current = true;
    list.scrollTop = restore?.scrollTop ?? list.scrollHeight;
  }, [items, listRef, restore]);
  useLayoutEffect(() => {
    // 向前展开时保持与底部的距离，正在读的内容不跳动。
    const anchor = prependAnchorRef.current;
    const list = listRef.current;
    if (anchor === null || !list) return;
    prependAnchorRef.current = null;
    list.scrollTop = list.scrollHeight - anchor;
  }, [listRef, visibleCount]);
  const loadEarlier = () => {
    const list = listRef.current;
    if (list) prependAnchorRef.current = list.scrollHeight - list.scrollTop;
    setVisibleCount((count) => count + TIMELINE_PAGE_SIZE);
  };
  return <>
    <MessageList items={visibleItems} projectionItems={items} hasEarlier={hasEarlier} onLoadEarlier={loadEarlier} earlierLocal gapBefore={gapBefore} topNotice={!hasEarlier && missingStart ? t.timeline.earlierNotSaved : null} listRef={listRef} bottomSentinelRef={bottomSentinelRef} onScroll={() => {}} isLive={false} loading={loading || skeletonVisible} skeletonVisible={skeletonVisible} />
    <div className="pwa-chat-footer">
      <ReadOnlyComposer notice={t.workspace.readOnlyNote} modelName={modelName} thinking={thinking} />
    </div>
  </>;
}

/** 主区空状态：阅读列中部偏上，图标、标题、一行说明，最多一个操作。 */
function WorkspaceEmptyState({ icon, title, children, detail, action }: { icon: ReactNode; title: string; children?: ReactNode; detail?: ReactNode; action?: ReactNode }) {
  return <div className="pwa-workspace-state">
    <span className="pwa-workspace-state-icon" aria-hidden="true">{icon}</span>
    <h2>{title}</h2>
    {children ? <p>{children}</p> : null}
    {detail}
    {action}
  </div>;
}

/** 命令单独成行：等宽命令加复制按钮，说明文字不再夹着按钮。 */
function CopyCommand({ command }: { command: string }) {
  const { t } = useI18n();
  return <div className="pwa-command-block"><code>{command}</code><CopyButton className="pwa-command-copy-button" text={command} label={t.workspace.copyCommand} /></div>;
}

export function UnpairedWorkspace({ onPair }: { onPair: () => void }) {
  const { t } = useI18n();
  return <WorkspaceEmptyState
    icon={<Link2 size={24} />}
    title={t.workspace.unpairedTitle}
    detail={<CopyCommand command={PAIR_COMMAND} />}
    action={<Button type="button" onClick={onPair}>{t.workspace.startPairing}</Button>}
  >{t.workspace.unpairedBody}</WorkspaceEmptyState>;
}

export function NoPiWorkspace({ onViewHistory }: { onViewHistory?: () => void }) {
  const { t } = useI18n();
  return <WorkspaceEmptyState
    icon={<Radio size={24} />}
    title={t.workspace.noPiTitle}
    action={onViewHistory ? <Button variant="transparent" color="piReach" type="button" leftSection={<History size={16} />} onClick={onViewHistory}>{t.workspace.viewHistory}</Button> : undefined}
  >{t.workspace.noPiBody}</WorkspaceEmptyState>;
}

export function ChooseComputerWorkspace() {
  const { t } = useI18n();
  return <WorkspaceEmptyState icon={<Computer size={24} />} title={t.workspace.chooseComputerTitle}>{t.workspace.chooseComputerBody}</WorkspaceEmptyState>;
}

/** 多个在线 Pi 且没有可沿用的选择时，直接在主区列出供选择；运行中的排在前面，其余保持原顺序。 */
export function ChoosePiWorkspace({ endpoints, completedEndpointIds, onSelect }: { endpoints: readonly PwaEndpointRecord[]; completedEndpointIds?: ReadonlySet<string>; onSelect: (endpointId: string) => void }) {
  const { t } = useI18n();
  const ordered = [...endpoints].sort((left, right) => Number(right.working === true) - Number(left.working === true));
  return <div className="pwa-workspace-state pwa-choose-pi">
    <h2>{t.workspace.choosePiTitle(endpoints.length)}</h2>
    <div className="pwa-choose-pi-list">
      {ordered.map((endpoint) => <OnlinePiRow key={endpoint.id} endpoint={endpoint} current={false} completed={completedEndpointIds?.has(endpoint.endpointId) ?? false} onSelect={() => onSelect(endpoint.endpointId)} trailing={<ChevronRight size={16} aria-hidden="true" />} />)}
    </div>
  </div>;
}

/** 打开会话时按真实消息布局排 3 行骨架，完成后原位替换；可见时机由调用方的 useDelayedVisibility 决定。 */
export function WorkspaceSkeleton({ visible }: { visible: boolean }) {
  const { t } = useI18n();
  return <div className="pwa-message-list pwa-skeleton-list" aria-busy="true">
    <span className="pwa-sr-only" role="status">{t.workspace.loading}</span>
    {visible ? <div className="pwa-skeleton-rows" aria-hidden="true">
      <span className="pwa-skeleton pwa-skeleton-user" />
      <span className="pwa-skeleton pwa-skeleton-line" />
      <span className="pwa-skeleton pwa-skeleton-line pwa-skeleton-short" />
    </div> : null}
  </div>;
}
