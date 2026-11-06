import { useEffect, useMemo, useRef, type ReactNode, type Ref } from "react";
import { CopyButton } from "@/components/pwa/copy-button";
import { Button } from "@mantine/core";
import { ChevronRight, CloudOff, Computer, Download, History, Link2, LoaderCircle, Radio, WifiOff } from "lucide-react";
import { BrandMark } from "@/components/pwa/brand-mark";
import { InstallSteps, useInstallCopy, usePwaInstall, type InstallOffer } from "@/components/pwa/pwa-install";
import type { ConnectionHintStage, ConnectionIssueKind } from "@/lib/pwa/connection-hint";
import { SMALL_SPINNER_SIZE, SMALL_SPINNER_STROKE } from "@/lib/ui/icon-metrics";
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
  /** 只读历史的真实来源；切换历史时清理上一份展示与阅读器选择。 */
  sourceKey: string;
  /** 手动展开或阅读器打开期间暂停跟随，与在线会话共用阅读锁。 */
  onReadingChange?: (reading: boolean) => void;
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
  viewport: Pick<TimelineViewport, "messageListRef" | "bottomSentinelRef" | "handleScroll" | "followingOutput" | "latestEntryVisible" | "showLatest">;
  /** 该 Pi 最后已知的模型与思考级别，只读输入区按在线样式显示。 */
  modelName: string | null;
  thinking: ThinkingLevel;
};

/**
 * 只读历史：与在线会话同一个时间线组件与视口，向前翻页、阅读位置与「最新」的行为一致；
 * 只换底部为只读输入区，并标出未保存在此浏览器的区间。
 */
export function HistoryConversation({ sourceKey, onReadingChange, items, savedEvents, hasEarlier, loadingEarlier, loadEarlierFailed, onLoadEarlier, loading, viewport, modelName, thinking }: HistoryConversationProps) {
  const { t } = useI18n();
  const projection = useMemo(() => savedEvents.map((event): TimelineViewItem => ({ kind: "event", event })), [savedEvents]);
  const { gapBefore, missingStart } = useMemo(() => savedRangeGaps(savedEvents), [savedEvents]);
  const skeletonVisible = useDelayedVisibility(loading);
  const following = viewport.followingOutput;
  return <TimelineWorkspace
    timeline={<MessageList sourceKey={sourceKey} onReadingChange={onReadingChange} items={items} projectionItems={projection} hasEarlier={hasEarlier} loadingEarlier={loadingEarlier} onLoadEarlier={onLoadEarlier} loadEarlierFailed={loadEarlierFailed} autoLoadEarlier={!following} earlierLocal gapBefore={gapBefore} topNotice={!hasEarlier && missingStart ? t.timeline.earlierNotSaved : null} listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} isLive={false} loading={loading || skeletonVisible} skeletonVisible={skeletonVisible} />}
    footer={<>
      <PwaMessageActions show={viewport.latestEntryVisible} showRetry={false} showLatest={viewport.latestEntryVisible} unreadOutput={0} onRetry={() => {}} onLatest={viewport.showLatest} />
      <ReadOnlyComposer notice={t.workspace.readOnlyNote} modelName={modelName} thinking={thinking} />
    </>}
  />;
}

type WorkspaceEmptyStateProps = {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  /** 首次使用流程的步骤进度，位于图标上方。 */
  progress?: ReactNode;
  /** 流程换步时把焦点交给新标题，读屏从标题开始读新的一步。 */
  headingRef?: Ref<HTMLHeadingElement>;
};

/** 主区空状态：阅读列中部偏上，图标、标题、一行说明，最多一个操作。 */
function WorkspaceEmptyState({ icon, title, children, detail, action, progress, headingRef }: WorkspaceEmptyStateProps) {
  return <div className={progress ? "pwa-workspace-state pwa-onboarding" : "pwa-workspace-state"}>
    {progress}
    <span className="pwa-workspace-state-icon" aria-hidden="true">{icon}</span>
    <h2 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>{title}</h2>
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

/**
 * 未配对：浏览器标签页中可以安装时是两步的首次使用流程，一屏只做一件事——先安装，再配对
 * （ADR-20261106「安装引导」）；已从主屏幕、程序坞或应用窗口打开时只有配对。
 */
export function UnpairedWorkspace({ onPair }: { onPair: () => void }) {
  const { t } = useI18n();
  const { offer, deferred, setDeferred, install } = usePwaInstall();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pairRef = useRef<HTMLButtonElement>(null);
  // 换步或安装完成后，被点按的按钮随旧的一步卸载：换步时焦点交给新标题，安装后交给「开始配对」。
  const focusAfterChangeRef = useRef<"heading" | "pair" | null>(null);
  useEffect(() => {
    const target = focusAfterChangeRef.current;
    focusAfterChangeRef.current = null;
    if (target === "heading") headingRef.current?.focus({ preventScroll: true });
    if (target === "pair") pairRef.current?.focus();
  }, [offer, deferred]);

  if (offer && !deferred) return <InstallStep
    offer={offer}
    headingRef={headingRef}
    onInstall={() => { focusAfterChangeRef.current = "pair"; void install(); }}
    onContinue={() => { focusAfterChangeRef.current = "heading"; setDeferred(true); }}
  />;

  const n = t.install;
  const pairButton = <Button ref={pairRef} type="button" onClick={onPair}>{t.workspace.startPairing}</Button>;
  return <WorkspaceEmptyState
    icon={<Link2 size={24} />}
    title={offer ? n.pairTitle : t.workspace.unpairedTitle}
    detail={<CopyCommand command={PAIR_COMMAND} />}
    action={offer
      ? <div className="pwa-onboarding-actions">
        {pairButton}
        <Button type="button" variant="transparent" onClick={() => { focusAfterChangeRef.current = "heading"; setDeferred(false); }}>{n.backToInstall}</Button>
      </div>
      : pairButton}
    progress={offer ? <OnboardingProgress step={2} /> : undefined}
    headingRef={offer ? headingRef : undefined}
  >{t.workspace.unpairedBody}</WorkspaceEmptyState>;
}

const ONBOARDING_STEPS = 2;

/** 步骤进度：圆点加「第 N 步，共 2 步」，已到达的步骤圆点为 accent。 */
function OnboardingProgress({ step }: { step: number }) {
  const n = useI18n().t.install;
  return <div className="pwa-onboarding-progress">
    <span className="pwa-onboarding-dots" aria-hidden="true">
      {Array.from({ length: ONBOARDING_STEPS }, (_, index) => <span key={index} data-reached={index < step ? "" : undefined} />)}
    </span>
    {n.stepOf(step, ONBOARDING_STEPS)}
  </div>;
}

function InstallStep({ offer, headingRef, onInstall, onContinue }: { offer: InstallOffer; headingRef: Ref<HTMLHeadingElement>; onInstall: () => void; onContinue: () => void }) {
  const n = useI18n().t.install;
  const { title, lead } = useInstallCopy(offer);
  return <WorkspaceEmptyState
    icon={<span className="pwa-onboarding-mark"><BrandMark size={24} /></span>}
    title={title}
    detail={<InstallSteps offer={offer} thenPair />}
    action={<div className="pwa-onboarding-actions">
      {offer === "prompt" ? <Button type="button" leftSection={<Download size={16} />} onClick={onInstall}>{n.install}</Button> : null}
      <Button type="button" variant="transparent" onClick={onContinue}>{n.useInBrowser}</Button>
    </div>}
    progress={<OnboardingProgress step={1} />}
    headingRef={headingRef}
  >{lead}</WorkspaceEmptyState>;
}

export function NoPiWorkspace({ onViewHistory }: { onViewHistory?: () => void }) {
  const { t } = useI18n();
  return <WorkspaceEmptyState
    icon={<Radio size={24} />}
    title={t.workspace.noPiTitle}
    action={onViewHistory ? <Button variant="transparent" type="button" leftSection={<History size={16} />} onClick={onViewHistory}>{t.workspace.viewHistory}</Button> : undefined}
  >{t.workspace.noPiBody}</WorkspaceEmptyState>;
}

/**
 * 未打开会话时的连接问题（ADR-20261105）：此时没有输入框，说明放在主区空态。
 * Relay 断线 3 秒后说明正在重连，10 秒后说明自动重试并提供立即重试；无网络时只说明恢复后自动重连。
 */
export function ConnectionIssueWorkspace({ kind, stage, busy, onRetry, retryDisabled }: { kind: ConnectionIssueKind; stage: ConnectionHintStage; busy: boolean; onRetry: () => void; retryDisabled: boolean }) {
  const { t } = useI18n();
  if (kind === "network") return <WorkspaceEmptyState icon={<WifiOff size={24} />} title={t.connection.networkUnavailableTitle}>{t.connection.networkWaitingBody}</WorkspaceEmptyState>;
  const retry = stage === "retry";
  const body = retry ? (busy ? t.connection.autoRetrying : t.connection.unavailable) : t.connection.reconnectingHint;
  return <WorkspaceEmptyState
    icon={<CloudOff size={24} />}
    title={t.connection.relayUnreachableTitle}
    action={retry ? <Button variant="default" type="button" disabled={retryDisabled} onClick={onRetry}>{t.connection.retryNow}</Button> : undefined}
  ><span className="pwa-workspace-state-busy" role="status">{busy || !retry ? <LoaderCircle className="pwa-spin" size={SMALL_SPINNER_SIZE} strokeWidth={SMALL_SPINNER_STROKE} aria-hidden="true" /> : null}{body}</span></WorkspaceEmptyState>;
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
