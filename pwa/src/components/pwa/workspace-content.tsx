import { useMemo, type ReactNode } from "react";
import { CopyButton } from "@/components/pwa/copy-button";
import { Button } from "@mantine/core";
import { ChevronRight, Computer, History, Link2, Radio } from "lucide-react";
import { OnlinePiRow } from "@/components/pwa/workspace-view";
import { MessageList } from "@/components/pwa/message-list";
import { ReadOnlyComposer } from "@/components/pwa/message-composer";
import { PwaMessageActions } from "@/components/pwa/pwa-app-actions";
import type { ThinkingLevel } from "@/lib/pi-reach/types";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { savedRangeGaps } from "@/lib/pwa/timeline-local-pager";
import type { TimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import type { PwaEndpointRecord } from "@/lib/pwa/db";
import { useI18n } from "@/lib/i18n";
import { useDelayedVisibility } from "./use-delayed-visibility";

export { useDelayedVisibility };

const PAIR_COMMAND = "/pi-reach pair";

/** 会话主区：时间线加底部操作区；在线会话与只读历史共用，只换底部输入区。 */
export function TimelineWorkspace({ timeline, footer }: { timeline: ReactNode; footer: ReactNode }) {
  return <>
    {timeline}
    <div className="pwa-chat-footer">{footer}</div>
  </>;
}

type HistoryConversationProps = {
  /** 当前已展开的记录（运行时只读投影）。 */
  items: TimelineViewItem[];
  /** 本地保存的全部正式记录：附件元数据可能落在已展开的范围之外，缺口按全集的序号标出。 */
  savedEvents: readonly TimelineEvent[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
  loadEarlierFailed: boolean;
  onLoadEarlier: () => void;
  /** 正在读取本地记录；读完之前不把空列表当作「没有记录」。 */
  loading: boolean;
  viewport: Pick<TimelineViewport, "messageListRef" | "bottomSentinelRef" | "handleScroll" | "followingOutput" | "showLatest">;
  /** 该 Pi 最后已知的模型与思考级别，只读输入区按在线样式显示。 */
  modelName: string | null;
  thinking: ThinkingLevel;
};

/**
 * 只读历史：与在线会话同一个时间线组件与视口，向前翻页、阅读位置与「最新」的行为一致；
 * 只换底部为只读输入区，并标出未保存在此浏览器的区间。
 */
export function HistoryConversation({ items, savedEvents, hasEarlier, loadingEarlier, loadEarlierFailed, onLoadEarlier, loading, viewport, modelName, thinking }: HistoryConversationProps) {
  const { t } = useI18n();
  const projection = useMemo(() => savedEvents.map((event): TimelineViewItem => ({ kind: "event", event })), [savedEvents]);
  const { gapBefore, missingStart } = useMemo(() => savedRangeGaps(savedEvents), [savedEvents]);
  const skeletonVisible = useDelayedVisibility(loading);
  const following = viewport.followingOutput;
  return <TimelineWorkspace
    timeline={<MessageList items={items} projectionItems={projection} hasEarlier={hasEarlier} loadingEarlier={loadingEarlier} onLoadEarlier={onLoadEarlier} loadEarlierFailed={loadEarlierFailed} autoLoadEarlier={!following} earlierLocal gapBefore={gapBefore} topNotice={!hasEarlier && missingStart ? t.timeline.earlierNotSaved : null} listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} isLive={false} loading={loading || skeletonVisible} skeletonVisible={skeletonVisible} />}
    footer={<>
      <PwaMessageActions show={!following} showRetry={false} showLatest={!following} unreadOutput={0} onRetry={() => {}} onLatest={viewport.showLatest} />
      <ReadOnlyComposer notice={t.workspace.readOnlyNote} modelName={modelName} thinking={thinking} />
    </>}
  />;
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
    action={onViewHistory ? <Button variant="transparent" type="button" leftSection={<History size={16} />} onClick={onViewHistory}>{t.workspace.viewHistory}</Button> : undefined}
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
