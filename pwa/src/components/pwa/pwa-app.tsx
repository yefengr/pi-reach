import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MessageComposer, ReadOnlyComposer } from "@/components/pwa/message-composer";
import { useSessionActions } from "@/lib/pwa/use-session-actions";
import { compactionTerminalKind, currentRunGroup, OPERATION_CONFIRMATION_TIMEOUT_MS, operationHint, stopHasEnded, type CompactionActivity, type CompactionNotice, type OperationHint } from "@/lib/pwa/operation-feedback";
import type { ModelListStatus } from "./composer-command-menu";
import { RenamePairingDialog } from "@/components/pwa/rename-pairing-dialog";
import { ConfirmActionDialog } from "@/components/pwa/confirm-action-dialog";
import { COMPOSER_THINKING_LEVELS } from "@/components/pwa/composer-command-menu";
import { MessageList } from "@/components/pwa/message-list";
import { PublishedFilesProvider } from "./published-files-context";
import { ToolDetailsProvider } from "./tool-details-context";
import { ToolDetailsController } from "@/lib/pwa/tool-details";
import { PersistentToolDetailsCache } from "@/lib/pwa/tool-details-cache";
import { useSessionFiles } from "./use-session-files";
import { isQueuedMessage, QueuedMessagesPanel } from "@/components/pwa/queued-messages-panel";
import { decodeBase64 } from "@/lib/pi-reach/encoding";
import { describeStartupFailure, StartupErrorView, StartupLoading, type StartupError } from "@/components/pwa/pwa-startup";
import { PairingDialog } from "@/components/pwa/pairing-dialog";
import { PwaMessageActions, PwaStatusError } from "@/components/pwa/pwa-app-actions";
import { CONNECTION_HINT_TIMING, connectionHint, type ConnectionHintStage, type ConnectionIssueKind } from "@/lib/pwa/connection-hint";
import { focusedElement, runConfirmAction, useConfirmationOverlay, type ConfirmActionRequest } from "@/components/pwa/pwa-confirm-actions";
import { SettingsPage } from "@/components/pwa/settings-page";
import { reloadWorkspace, useSettingsRoute } from "@/lib/pwa/settings-route";
import { SessionActionsMenu } from "@/components/pwa/session-actions-menu";
import { cwdName, displayDevice, type ConnectionViewState, type NavigationSwitchTarget, type WorkspaceNavigationProps } from "@/components/pwa/workspace-view";
import { useSwitchOutFade } from "@/components/pwa/use-switch-out-fade";
import { displayPi } from "@/components/pwa/session-title";
import { PwaWorkspaceLayout } from "@/components/pwa/pwa-workspace-layout";
import { PwaOperationNotifications, PwaToastProvider, useToast } from "@/components/pwa/pwa-operation-notifications";
import { ChooseComputerWorkspace, ChoosePiWorkspace, ConnectionIssueWorkspace, HistoryConversation, NoPiWorkspace, TimelineWorkspace, UnpairedWorkspace, useDelayedVisibility, WorkspaceSkeleton } from "@/components/pwa/workspace-content";
import type { WorkspaceTitleBarProps } from "@/components/pwa/workspace-title-bar";
import { PeerChannel } from "@/lib/pi-reach/peer-channel";
import { generateOwnerKeyPair } from "@/lib/pi-reach/crypto";
import { assertBrowserCapabilities, fromStoredKey, migrateLegacyDefaultRelay, toStoredKey, type ConnectionContext } from "@/lib/pwa/runtime";
import { deriveDeviceActivity, derivePairingPresence } from "@/lib/pwa/pwa-view-model";
import { readDefaultRelayUrl } from "@/lib/pwa/runtime-config";
import { useEndpointRegistry } from "@/lib/pwa/use-endpoint-registry";
import { useBackgroundCompletionNotices } from "@/lib/pwa/use-background-completion-notices";
import { useDevicePairing, type DevicePairingResult } from "@/lib/pwa/use-device-pairing";
import { ACTIVE_DEVICE_SETTING, activeEndpointSettingKey, useActiveEndpointSelection } from "@/lib/pwa/use-active-endpoint-selection";
import { PendingCapacityError, type QueuedCancellation, type TimelineScope } from "@/lib/pwa/timeline-runtime";
import { attachmentRetryDecision, submitMessage, type AttachmentLease } from "@/lib/pwa/message-submission";
import { SessionPositionStore } from "@/lib/pwa/session-position-store";
import { clearStoredDrafts, draftBelongsToDevice, readStoredDrafts } from "@/lib/pwa/draft-storage";
import { useDraftPersistence } from "@/lib/pwa/use-draft-persistence";
import { useTimeline } from "@/lib/pwa/use-timeline";
import { useHistorySessionList } from "@/lib/pwa/use-history-session-list";
import { useHistorySessionDetails } from "@/lib/pwa/use-history-session-details";
import { historySessionTitle } from "@/lib/pwa/history-preview";
import { useRelayConnection } from "@/lib/pwa/use-relay-connection";
import { attachmentTargetKey } from "@/lib/pwa/attachment-composer";
import { useAttachmentComposer } from "@/lib/pwa/use-attachment-composer";
import type { TimelineSessionSummary } from "@/lib/pwa/timeline-store";
import { receiveTimelineFrame } from "@/lib/pwa/timeline-frame-handler";
import { ReconnectState } from "@/lib/pwa/reconnect-state";
import { actionErrorFeedback, actionSendFailureFeedback, createOperationNotificationController } from "@/lib/pwa/operation-notifications";
import { safeFeedbackMessage, type FeedbackSource } from "@/lib/pwa/feedback-messages";
import { recoverServerFrame } from "@/lib/pwa/server-frame-recovery";
import type { ControlFrame, OwnerKeyPair, ThinkingLevel, WireModel } from "@/lib/pi-reach/types";
import type { ClientFrame, ServerFrame } from "@/lib/pi-reach/protocol-v2/frames";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { getMessages, useI18n } from "@/lib/i18n";
import {
  clearPwaData,
  getPwaDatabase,
  listPwaDevices,
  openPwaDatabase,
  removePwaDeviceData,
  type PwaDeviceRecord,
} from "@/lib/pwa/db";
import { MOBILE_LAYOUT_QUERY } from "@/lib/ui/viewport-queries";
import { useScrollIndicator } from "@/lib/ui/scroll-indicator";

const LEGACY_DEFAULT_RELAYS = ["https://relay-pi.yefengr.cn"];

const RELAY_SETTING = "relay_url";
type StartupState = "loading" | "ready" | "error";
type ComposerCommandRequest =
  | { action: "session_new" | "session_compact" }
  | { action: "model_set"; provider: string; modelId: string }
  | { action: "thinking_set"; level: ThinkingLevel };
type WorkspacePlaceholderKind = "choose-computer" | "checking" | "choose-pi" | "no-pi" | "opening";
type PwaWorkspaceTitleBar = Omit<WorkspaceTitleBarProps, "onOpenNavigation" | "navigationExpanded">;
function id(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function safeThinkingLevel(value: unknown): ThinkingLevel { return typeof value === "string" && COMPOSER_THINKING_LEVELS.includes(value as ThinkingLevel) ? value as ThinkingLevel : "off"; }
function resolveEndpointModel(models: readonly WireModel[], endpointModel: string | undefined): WireModel | undefined {
  if (!endpointModel) return undefined;
  const matches = models.filter((model) => model.id === endpointModel || model.name === endpointModel);
  return matches.length === 1 ? matches[0] : undefined;
}
const NO_EVENTS: readonly TimelineEvent[] = [];

export function PwaApp() {
  const sharedNotifications = useToast();
  return sharedNotifications ? <PwaAppContent operationNotifications={sharedNotifications} /> : <StandalonePwaApp />;
}

/** 单独挂载 PwaApp 的现有测试保留原有 controller 生命周期。 */
function StandalonePwaApp() {
  const [notifications] = useState(createOperationNotificationController);
  return <PwaToastProvider value={notifications}><PwaAppContent operationNotifications={notifications} standalone /></PwaToastProvider>;
}

function PwaAppContent({ operationNotifications, standalone = false }: { operationNotifications: ReturnType<typeof createOperationNotificationController>; standalone?: boolean }) {
  const { t } = useI18n();
  // 全应用滚动条只在滚动时出现；标记写在各滚动容器上，由 CSS 决定显隐。
  useScrollIndicator();
  const [identity, setIdentity] = useState<OwnerKeyPair | null>(null); const [devices, setDevices] = useState<PwaDeviceRecord[]>([]);
  const [connection, setConnection] = useState<ConnectionViewState>("offline");
  const [extensionVersion, setExtensionVersion] = useState<string | null>(null);
  const [connectionFeedback, setConnectionFeedback] = useState<ConnectionIssueKind | null>(null);
  const [sessionRestartToken, setSessionRestartToken] = useState(0);
  const [defaultRelayUrl, setDefaultRelayUrl] = useState("");
  const [relayUrl, setRelayUrl] = useState(""); const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>(readStoredDrafts);
  useDraftPersistence(drafts);
  const setDraftFor = useCallback((key: string, value: string) => setDrafts((current) => current[key] === value ? current : { ...current, [key]: value }), []);
  const [draftSessions, setDraftSessions] = useState<Readonly<Record<string, string>>>({});
  // 当前查看的 Pi 退出后保留会话原位显示，并暂停自动选择，直到用户选择其他 Pi 或离开。
  const [exitedEndpoint, setExitedEndpoint] = useState<import("@/lib/pwa/db").PwaEndpointRecord | null>(null);
  const [sessionSwitched, setSessionSwitched] = useState(false);
  const [models, setModels] = useState<WireModel[]>([]);
  const [currentModel, setCurrentModel] = useState<WireModel | null>(null);
  const [reportedThinking, setReportedThinking] = useState<ThinkingLevel | null>(null);
  const [modelsStatus, setModelsStatus] = useState<ModelListStatus>("idle");
  const [modelsRequestId, setModelsRequestId] = useState<string | null>(null);
  const [compactionActivity, setCompactionActivity] = useState<CompactionActivity | null>(null);
  // 压缩终态是本地提示：不写入历史，锚定发生时的记录；聊天区重建（成功压缩、切换会话）时清空。
  const [compactionNotices, setCompactionNotices] = useState<CompactionNotice[]>([]);
  const compactionNoticeSequenceRef = useRef(0);
  const previousCompactionActivityRef = useRef<CompactionActivity | null>(null);
  const noticeSessionRef = useRef<string | null>(null);

  // 远程压缩的终态由关联回执反馈；hooks 只显示活动，不重复提示同一次结束。
  const remoteCompactionPresentationRef = useRef(false);
  const { pendingAction, pendingActionRef, setPendingAction, receiveAction, observeSession, stopRequest, stopRequestRef, setStopRequest, disconnectActions, resetActions } = useSessionActions();
  const { route: settingsRoute, openSettings, closeSettings } = useSettingsRoute();
  const [renameDevice, setRenameDevice] = useState<PwaDeviceRecord | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmActionRequest | null>(null); const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const [startupState, setStartupState] = useState<StartupState>("loading"); const [startupError, setStartupError] = useState<StartupError | null>(null);
  const [selectedHistory, setSelectedHistory] = useState<TimelineSessionSummary | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [renameFocusOrigin, setRenameFocusOrigin] = useState<HTMLElement | null>(null);
  const [pairingFocusOrigin, setPairingFocusOrigin] = useState<HTMLElement | null>(null);
  const [liveEndpointSnapshot, setLiveEndpointSnapshot] = useState<import("@/lib/pwa/db").PwaEndpointRecord | null>(null);
  const [retryPending, setRetryPending] = useState(false);
  const [retainLiveSnapshot, setRetainLiveSnapshot] = useState(false);
  // 最近一次握手成功的实时会话，用于在本地历史中隐藏仍在线的同一会话。
  const [liveSession, setLiveSession] = useState<{ deviceId: string; endpointId: string; sessionId: string } | null>(null);

  const reportHistoryFailure = useCallback((message: string) => setError(safeFeedbackMessage(message, "history")), []);
  const reportRecoveryFailure = useCallback((message: string) => setRecoveryError(safeFeedbackMessage(message, "history")), []);
  const clearRecoveryFailure = useCallback(() => setRecoveryError(null), []);
  const reportSessionFailure = useCallback((message: string, source: FeedbackSource) => setError(safeFeedbackMessage(message, source)), []);
  const reportProtocolFailure = useCallback((message: string) => setError(safeFeedbackMessage(message, "protocol")), []);
  const channelRef = useRef<PeerChannel | null>(null); const draftVersionRef = useRef(0); const draftKeyRef = useRef("");
  const connectionGenerationRef = useRef(0); const connectionRef = useRef(connection); const selectedHistoryRef = useRef<TimelineSessionSummary | null>(selectedHistory);
  useLayoutEffect(() => { connectionRef.current = connection; selectedHistoryRef.current = selectedHistory; }, [connection, selectedHistory]);
  /** 发送瞬间读取 Pi 是否在运行：运行中发送的消息预计排队，直接显示在排队区。 */
  const piWorkingRef = useRef(false);
  const retryPendingRef = useRef(false); const retryDeviceIdRef = useRef<string | null>(null); const retryEndpointIdRef = useRef<string | null>(null);
  const sessionChannelIdRef = useRef(id()); const sessionRecoveryStateRef = useRef(new ReconnectState());
  const sessionIdentityRef = useRef<string | null>(null);
  const relaySelectionRef = useRef<{ deviceId: string | null; endpointId: string | null }>({ deviceId: null, endpointId: null });
  const channelContextRef = useRef<ConnectionContext | null>(null);
  const helloRequestRef = useRef<string | null>(null);
  const toolDetailsHelloRetriedRef = useRef(false);
  const toolDetailsSupportedRef = useRef(false);
  const [toolDetailsSupported, setToolDetailsSupported] = useState(false);
  const [toolDetailsController] = useState(() => new ToolDetailsController(new PersistentToolDetailsCache()));
  const modelRequestRef = useRef<string | null>(null);
  // 仅关联当前配置失败后的读回；列表请求接替时保留语义，不保存结果。
  const configurationReadbackRef = useRef<{ channelId: string; sessionId: string } | null>(null);
  const extensionInfoRequestRef = useRef<string | null>(null);
  const activeEndpointModelRef = useRef<string | undefined>(undefined);
  const activeEndpointThinkingRef = useRef<string | undefined>(undefined);
  const confirmPendingRef = useRef(false);
  const historyLoadTokenRef = useRef(0);
  const lastSessionByRuntimeRef = useRef(new Map<string, string>());
  const lastFocusedSessionRef = useRef<string | null>(null);
  const emptySessionFocusRef = useRef<string | null>(null);
  // 由运行时确认的排队消息撤回，交给当前输入区回填；帧处理回调经 ref 取最新的草稿与附件。
  const restoreQueuedRef = useRef<(cancellations: readonly QueuedCancellation[]) => boolean>(() => false);
  const {
    items: timelineItems,
    queueSnapshotReady,
    setLastSyncedAt,
    hasEarlier,
    loadingEarlier,
    loadEarlierFailed,
    reconnectPhase,
    catchupFailed,
    catchingUp,
    followingOutput,
    unreadOutput,
    latestEntryVisible,
    messageListRef,
    bottomSentinelRef,
    receiveRealtimeOutput,
    handleScroll,
    showLatest,
    captureOwnSend,
    followOwnSend,
    followingNow,
    reset: resetOutputFollowing,
    captureSessionPosition,
    restoreSessionPosition,
    setReadingDetails,
    runtimeRef: timelineRuntimeRef,
    historyLoaderRef,
    fragmentAssemblerRef,
    applyTimelineChange,
    displayPending: timelineDisplayPending,
    reportQueueCommit,
    startLive,
    retryCatchup,
    loadEarlier: loadEarlierTimeline,
    disconnect: disconnectTimeline,
    invalidateScope: invalidateTimelineScope,
    clearTimeline,
    switchLive: switchLiveTimeline,
    history: timelineHistory,
    openHistory: openTimelineHistory,
    historyShownCount,
  } = useTimeline({
    channelRef,
    reportHistoryFailure,
    reportRecoveryFailure,
    clearRecoveryFailure,
  });
  const sendReady = !catchingUp && !catchupFailed && !reconnectPhase;
  const sendReadyRef = useRef(sendReady);
  useLayoutEffect(() => { sendReadyRef.current = sendReady; });
  const timelineItemsRef = useRef(timelineItems);
  useLayoutEffect(() => { timelineItemsRef.current = timelineItems; }, [timelineItems]);

  // 压缩终态从活动状态推导，每种终态只追加一次；锚点取当前会话最后一条正式记录。
  useEffect(() => {
    const previous = previousCompactionActivityRef.current;
    previousCompactionActivityRef.current = compactionActivity;
    if (!compactionActivity || compactionActivity.status === "running" || compactionActivity.status === "completed") return;
    if (previous?.status === compactionActivity.status && previous.sessionId === compactionActivity.sessionId) return;
    const kind = compactionTerminalKind(compactionActivity);
    if (!kind) return;
    const sessionId = compactionActivity.sessionId;
    const afterSeq = timelineItems.reduce((max, item) => item.kind === "event" && item.event.event_seq !== undefined ? Math.max(max, item.event.event_seq) : max, 0);
    compactionNoticeSequenceRef.current += 1;
    setCompactionNotices((current) => [...current, { id: `compaction:${compactionNoticeSequenceRef.current}`, sessionId, afterSeq, kind }]);
  }, [compactionActivity, timelineItems]);

  // 切换会话时丢弃旧会话的本地提示；断线期间范围为空但会话内容仍在，保留提示等待重连。
  useLayoutEffect(() => {
    const sessionId = timelineRuntimeRef.current.currentScope?.sessionId ?? null;
    if (sessionId === null || noticeSessionRef.current === sessionId) return;
    noticeSessionRef.current = sessionId;
    setCompactionNotices((current) => current.filter((notice) => notice.sessionId === sessionId));
  }, [timelineItems, timelineRuntimeRef]);

  const switchOut = useSwitchOutFade(messageListRef);

  const attachmentLeasesRef = useRef(new Map<string, AttachmentLease>());
  const attachments = useAttachmentComposer((message) => {
    const scope = timelineRuntimeRef.current.currentScope;
    if (!sendReadyRef.current || timelineRuntimeRef.current.replacing || !scope || attachmentTargetKey(scope) !== message.target || draftKeyRef.current !== message.context.draftKey) return "not-handled";
    const outcome = submitMessage({
      text: message.text, attachments: message.attachments, scope, channel: channelRef.current,
      online: connectionRef.current === "online", historyOpen: selectedHistoryRef.current !== null,
      newSessionPending: pendingActionRef.current?.action === "session_new", runtime: timelineRuntimeRef.current,
      queueExpected: piWorkingRef.current, following: followingNow,
      capture: captureOwnSend, follow: followOwnSend, apply: applyTimelineChange,
      onPrepareError: (error) => reportSessionFailure(error instanceof PendingCapacityError ? error.message
        : error && typeof error === "object" && "invalidPayload" in error
          ? "This message is too large or invalid to send. Shorten it and try again."
          : "Could not send this message. Try again.", "message-send"),
    });
    if (outcome === "handled") {
      // 能力恢复回调可能同步触发交接，早于 React 提交；租约以交接消息为准，供明确失败后的重试比对。
      for (const attachment of message.attachments) attachmentLeasesRef.current.set(attachment.attachment_id, { target: message.target, uploadScope: message.uploadScope });
      if (draftVersionRef.current === message.context.draftVersion && draftKeyRef.current === message.context.draftKey) setDraftFor(message.context.draftKey, "");
    }
    return outcome;
  }, t.attachments);
  const attachmentComposer = attachments.composer;
  const addAttachmentFiles = attachments.addFiles;
  const connectReadyAttachments = useCallback(() => {
    const runtime = timelineRuntimeRef.current;
    const scope = runtime.currentScope;
    const channel = channelRef.current;
    const context = channelContextRef.current;
    if (!scope || !channel || channel.closed || context?.channel !== channel || connectionRef.current !== "online" || selectedHistoryRef.current !== null) return;
    if (scope.channelId !== channel.channelId || scope.deviceId !== context.deviceId || scope.endpointId !== context.endpointId || scope.runtimeInstanceId !== context.runtimeInstanceId) return;
    const snapshot = attachmentComposer.snapshot();
    // 初始能力发现不发送消息；只有同目标的原批次可能在 connect 中同步交接，必须等待恢复提交。
    if (snapshot.active && snapshot.target === attachmentTargetKey(scope) && (!sendReadyRef.current || runtime.replacing)) return;
    attachmentComposer.connect(scope, (request) => channel.send(request));
  }, [attachmentComposer, timelineRuntimeRef]);
  const { controller: fileController, readyRef: filesReadyRef, view: fileView, onToolReading } = useSessionFiles({
    ready: connection === "online" && selectedHistory === null && !catchingUp && !catchupFailed && !reconnectPhase,
    items: timelineItems, runtimeRef: timelineRuntimeRef, channelRef, setReading: setReadingDetails,
  });

  const onDeviceSelected = useCallback(() => {
    operationNotifications.clearSession();
    resetActions(); setModels([]); setCurrentModel(null); setReportedThinking(null); setModelsStatus("idle"); setCompactionActivity(null);
    historyLoadTokenRef.current += 1;
    setSelectedHistory(null); setHistoryError(null);
    setLiveEndpointSnapshot(null);
    setExitedEndpoint(null);
    setSessionSwitched(false);
    clearTimeline();
    setError(null);
  }, [clearTimeline, operationNotifications, resetActions]);
  const reportRegistryFailure = useCallback(() => operationNotifications.show("registry-save"), [operationNotifications]);
  const reportPreferenceSaveFailure = useCallback(() => operationNotifications.show("preference-save"), [operationNotifications]);
  const { endpoints, snapshotDeviceIds, applyControl, markAllOffline, invalidatePersistence } = useEndpointRegistry({ devices, activeDevice: null, onError: reportRegistryFailure });
  const {
    activeDeviceId,
    activeEndpointId,
    activeDevice,
    selectDevice,
    selectEndpoint,
    restoreActiveDevice,
    activatePairedDevice,
    isActiveDevice,
  } = useActiveEndpointSelection({
    devices,
    endpoints,
    snapshotDeviceIds,
    automaticSelectionPaused: selectedHistory !== null || exitedEndpoint !== null,
    onDeviceSelected,
    onPreferenceSaveError: reportPreferenceSaveFailure,
  });

  // 切换电脑／Pi／历史会重建聊天区；断线不改变选择，因此不会触发，提示可留到重连。
  const noticeSelectionKey = `${activeDevice?.deviceId ?? ""}|${activeEndpointId ?? ""}|${selectedHistory?.id ?? ""}`;
  const [noticeSelection, setNoticeSelection] = useState(noticeSelectionKey);
  if (noticeSelection !== noticeSelectionKey) {
    setNoticeSelection(noticeSelectionKey);
    setCompactionNotices([]);
  }

  const activeEndpoint = useMemo(() => activeDevice && activeEndpointId ? endpoints.find((endpoint) => endpoint.deviceId === activeDevice.deviceId && endpoint.endpointId === activeEndpointId) ?? null : null, [activeDevice, activeEndpointId, endpoints]);
  useEffect(() => {
    if (!activeEndpoint) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const snapshot = { ...activeEndpoint };
      delete snapshot.online;
      setLiveEndpointSnapshot(snapshot);
      setRetainLiveSnapshot(false);
    });
    return () => { cancelled = true; };
  }, [activeEndpoint]);
  useEffect(() => {
    // 同一 Pi 进程（runtime 实例不变）重新出现在在线列表中，说明只是 Relay 重启等短暂缺席，不是退出：恢复实时会话。
    // 同一目录再启动的 Pi 是新实例，runtime 不同，仍按「已退出」保留原位。
    if (!exitedEndpoint) return;
    const returned = endpoints.some((endpoint) => endpoint.online !== false && endpoint.deviceId === exitedEndpoint.deviceId && endpoint.endpointId === exitedEndpoint.endpointId && endpoint.runtimeInstanceId === exitedEndpoint.runtimeInstanceId);
    if (!returned) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) setExitedEndpoint(null); });
    return () => { cancelled = true; };
  }, [endpoints, exitedEndpoint]);
  const liveEndpointSnapshotRef = useRef(liveEndpointSnapshot);
  useLayoutEffect(() => { liveEndpointSnapshotRef.current = liveEndpointSnapshot; }, [liveEndpointSnapshot]);
  const liveViewActive = selectedHistory === null;
  const exitedDisplay = liveViewActive && exitedEndpoint && activeDevice && exitedEndpoint.deviceId === activeDevice.deviceId ? exitedEndpoint : null;
  const displayEndpoint = activeEndpoint ?? exitedDisplay ?? (liveViewActive
    && retainLiveSnapshot
    && activeDevice
    && liveEndpointSnapshot?.deviceId === activeDevice.deviceId
    ? liveEndpointSnapshot
    : null);
  const endpointDraftKey = displayEndpoint ? `${displayEndpoint.deviceId}\u0000${displayEndpoint.endpointId}` : "";
  const draftSession = displayEndpoint ? draftSessions[`${endpointDraftKey}\u0000${displayEndpoint.runtimeInstanceId}`] : null;
  const draftKey = displayEndpoint ? JSON.stringify([displayEndpoint.deviceId, displayEndpoint.endpointId, displayEndpoint.runtimeInstanceId, draftSession ?? null]) : "";
  useLayoutEffect(() => { if (draftKeyRef.current !== draftKey) { draftVersionRef.current += 1; draftKeyRef.current = draftKey; } }, [draftKey]);
  const piWorking = displayEndpoint?.working === true;
  useLayoutEffect(() => { piWorkingRef.current = piWorking; }, [piWorking]);
  const currentViewKey = selectedHistory ? `history:${selectedHistory.id}` : displayEndpoint ? `live:${endpointDraftKey}` : null;
  useLayoutEffect(() => { currentViewKeyRef.current = currentViewKey; }, [currentViewKey]);
  const draft = drafts[draftKey] ?? "";
  const activeThinking = reportedThinking ?? safeThinkingLevel(displayEndpoint?.thinking);
  const sessionDeviceId = liveViewActive ? activeDevice?.deviceId ?? null : null;
  const sessionEndpointId = liveViewActive ? activeEndpoint?.endpointId ?? null : null;
  const sessionRuntimeInstanceId = liveViewActive ? activeEndpoint?.runtimeInstanceId ?? null : null;
  const sessionOnline = liveViewActive && activeEndpoint?.online === true;
  const pairingPresence = useMemo(() => derivePairingPresence(devices, endpoints), [devices, endpoints]);
  const activePis = useMemo(() => activeDevice ? endpoints.filter((endpoint) => endpoint.deviceId === activeDevice.deviceId) : [], [activeDevice, endpoints]);
  const snapshotReady = activeDevice ? snapshotDeviceIds.includes(activeDevice.deviceId) : false;
  useEffect(() => {
    relaySelectionRef.current = {
      deviceId: activeDevice?.deviceId ?? null,
      endpointId: activeEndpoint?.endpointId ?? liveEndpointSnapshot?.endpointId ?? null,
    };
  }, [activeDevice?.deviceId, activeEndpoint?.endpointId, liveEndpointSnapshot?.endpointId]);

  const clearSessionConnection = useCallback(() => {
    toolDetailsController.disconnect();
    toolDetailsSupportedRef.current = false;
    setToolDetailsSupported(false);
    toolDetailsHelloRetriedRef.current = false;
    fileController.disconnect();
    filesReadyRef.current = false;
    connectionGenerationRef.current += 1;
    channelRef.current?.close();
    channelRef.current = null;
    channelContextRef.current = null;
    helloRequestRef.current = null;
    modelRequestRef.current = null;
    configurationReadbackRef.current = null;
    operationNotifications.clearSession({ toastsOnly: true });
    extensionInfoRequestRef.current = null;
    disconnectActions();
    setModelsRequestId(null);
    setModelsStatus((current) => current === "loading" ? "error" : current);
    setCompactionActivity((current) => current?.status === "running" ? { ...current, status: "unknown" } : current);
    setExtensionVersion(null);
    disconnectTimeline();
    attachmentComposer.disconnect();
  }, [attachmentComposer, disconnectActions, disconnectTimeline, fileController, filesReadyRef, operationNotifications, toolDetailsController]);
  const finishRetry = useCallback(() => {
    retryPendingRef.current = false;
    retryDeviceIdRef.current = null;
    retryEndpointIdRef.current = null;
    setRetryPending(false);
  }, []);
  const handleRelayControl = useCallback((frame: ControlFrame) => {
    applyControl(frame);
    if (frame.type !== "endpoints" || frame.device_id !== relaySelectionRef.current.deviceId) return;
    const expectedEndpointId = relaySelectionRef.current.endpointId;
    const targetAvailable = expectedEndpointId
      ? frame.endpoints.some((endpoint) => endpoint.endpoint_id === expectedEndpointId)
      : frame.endpoints.length > 0;
    if (targetAvailable) return;
    finishRetry();
    setRetainLiveSnapshot(false);
    // 当前查看的 Pi 已从在线列表消失：保留会话原位，标记为已退出。
    const exited = liveEndpointSnapshotRef.current;
    if (expectedEndpointId && exited?.endpointId === expectedEndpointId && selectedHistoryRef.current === null) setExitedEndpoint(exited);
    setConnection("offline");
  }, [applyControl, finishRetry]);
  const handleRelayDisconnect = useCallback((retainSnapshot: boolean) => {
    setRetainLiveSnapshot(retainSnapshot);
    clearSessionConnection();
  }, [clearSessionConnection]);
  const {
    relayRef,
    onlineRef,
    relayStatus,
    relayVersion,
    generation: relayConnectionGeneration,
    reconnectNow: reconnectRelayNow,
    resubscribe: resubscribeRelay,
    closeIntentionally: closeRelayIntentionally,
  } = useRelayConnection({
    identity,
    ready: startupState === "ready",
    relayUrl,
    devices,
    onControl: handleRelayControl,
    onSessionDisconnect: handleRelayDisconnect,
    onAllEndpointsOffline: markAllOffline,
    onRetryFinished: finishRetry,
    setConnection,
    setConnectionFeedback,
  });
  const restartSession = useCallback(() => {
    setError(null);
    sessionRecoveryStateRef.current.replacementBye();
    clearSessionConnection();
    if (!onlineRef.current) { finishRetry(); setConnection("no_network"); return; }
    setConnection("connecting");
    setSessionRestartToken((token) => token + 1);
  }, [clearSessionConnection, finishRetry, onlineRef, setError]);
  const disconnectSession = useCallback(() => {
    sessionRecoveryStateRef.current.terminalBye();
    clearSessionConnection();
    finishRetry();
    setConnection(onlineRef.current ? "offline" : "no_network");
  }, [clearSessionConnection, finishRetry, onlineRef]);
  const retryCurrentSession = useCallback(() => {
    if (retryPendingRef.current || connection === "connecting") return;
    if (!onlineRef.current) { finishRetry(); setConnectionFeedback("network"); setConnection("no_network"); return; }
    setError(null);
    retryPendingRef.current = true;
    retryDeviceIdRef.current = activeDevice?.deviceId ?? null;
    retryEndpointIdRef.current = activeEndpoint?.endpointId ?? liveEndpointSnapshot?.endpointId ?? null;
    setRetryPending(true);
    sessionRecoveryStateRef.current.userRecover();
    clearSessionConnection();
    setConnectionFeedback("relay");
    setConnection("connecting");
    const relay = relayRef.current;
    if (!relay || relay.state !== "open") {
      reconnectRelayNow();
      return;
    }
    if (!activeEndpoint) {
      if (!resubscribeRelay()) { finishRetry(); setConnection("offline"); }
      return;
    }
    setSessionRestartToken((token) => token + 1);
  }, [activeDevice?.deviceId, activeEndpoint, clearSessionConnection, connection, finishRetry, liveEndpointSnapshot?.endpointId, onlineRef, reconnectRelayNow, relayRef, resubscribeRelay, setError]);
  const { historySessions, historyListStatus, refreshHistory } = useHistorySessionList({
    deviceId: activeDevice?.deviceId ?? null,
    onError: reportHistoryFailure,
    onSessionsLoaded: useCallback((sessions) => {
      setSelectedHistory((current) => current ? sessions.find((session) => session.id === current.id) ?? current : null);
    }, []),
  });
  const { rememberSessionDetails, invalidateSessionDetails } = useHistorySessionDetails({ endpoint: activeEndpoint, runtimeRef: timelineRuntimeRef, channelRef, helloRequestRef, onSaved: refreshHistory, onError: reportHistoryFailure, replacingSession: pendingAction?.action === "session_new" });
  // 切回看过的会话时恢复离开时的阅读位置；另写入 sessionStorage，页面被系统回收重载后仍能回到原处。首次打开停在底部最新内容。
  // 两种会话都按「跟随最新」或「屏幕顶部那一行」保存；历史另记已展开的条数，切回时先展开到同一范围再按行定位。
  const [sessionPositions] = useState(() => new SessionPositionStore());
  const currentViewKeyRef = useRef<string | null>(null);
  const rememberSessionPosition = useCallback(() => {
    const key = currentViewKeyRef.current;
    if (!key) return;
    const position = captureSessionPosition();
    if (!position) return;
    if (!key.startsWith("history:")) { sessionPositions.set(key, position); return; }
    const shown = historyShownCount();
    if (shown !== null) sessionPositions.set(key, { history: true, position, shown });
  }, [captureSessionPosition, historyShownCount, sessionPositions]);
  // 转入后台或卸载前记下当前会话的位置：主屏 PWA 在后台随时可能被系统回收，之后不再有机会保存。
  useEffect(() => {
    const hidden = () => { if (document.hidden) rememberSessionPosition(); };
    window.addEventListener("pagehide", rememberSessionPosition);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", rememberSessionPosition);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [rememberSessionPosition]);
  // 重载后自动进入的在线会话不经过 openLiveEndpoint：首次显示时按上次保存的位置恢复一次。
  const startupPositionRef = useRef(true);
  useLayoutEffect(() => {
    if (!startupPositionRef.current || !currentViewKey) return;
    startupPositionRef.current = false;
    const saved = currentViewKey.startsWith("live:") ? sessionPositions.get(currentViewKey) : undefined;
    if (saved && !("history" in saved)) restoreSessionPosition(saved);
  }, [currentViewKey, restoreSessionPosition, sessionPositions]);
  const openHistory = useCallback((history: TimelineSessionSummary) => {
    operationNotifications.clearSession();
    resetActions(); setCompactionActivity(null);
    rememberSessionPosition();
    const saved = sessionPositions.get(`history:${history.id}`);
    const restore = saved && "history" in saved ? saved : null;
    const token = ++historyLoadTokenRef.current;
    setExitedEndpoint(null);
    setSessionSwitched(false);
    setSelectedHistory(history);
    setHistoryError(null);
    clearSessionConnection();
    void openTimelineHistory({ deviceId: history.deviceId, endpointId: history.endpointId, sessionId: history.sessionId }, restore?.shown).then((status) => {
      if (status === "error" && token === historyLoadTokenRef.current) setHistoryError("Could not read the saved conversation.");
    });
    restoreSessionPosition(restore?.position ?? null);
  }, [clearSessionConnection, openTimelineHistory, operationNotifications, rememberSessionPosition, resetActions, restoreSessionPosition, sessionPositions]);
  const openLiveEndpoint = useCallback((endpointId: string) => {
    if (selectedHistory !== null || activeEndpointId !== endpointId) { setExtensionVersion(null); resetActions(); setModels([]); setCurrentModel(null); setReportedThinking(null); setModelsStatus("idle"); setCompactionActivity(null); }
    operationNotifications.clearSession();
    historyLoadTokenRef.current += 1;
    setSelectedHistory(null); setHistoryError(null);
    const switching = liveEndpointSnapshot?.endpointId !== endpointId;
    if (switching) { setLiveEndpointSnapshot(null); setSessionSwitched(false); }
    setExitedEndpoint(null);
    rememberSessionPosition();
    if ((switching || selectedHistory !== null) && activeDevice) {
      // 换到另一个 Pi 或离开只读历史时立即撤下当前投影，不让它留在新标题下；回到同一个 Pi 也重新握手，不复用历史投影。
      // 本次访问握手过的会话最准确，否则取本地历史中该 Pi 最近的会话作预览。
      const deviceId = activeDevice.deviceId;
      const target = endpoints.find((endpoint) => endpoint.deviceId === deviceId && endpoint.endpointId === endpointId);
      const remembered = target ? lastSessionByRuntimeRef.current.get(`${deviceId}\u0000${endpointId}\u0000${target.runtimeInstanceId}`) : undefined;
      const sessionId = remembered ?? historySessions.find((session) => session.endpointId === endpointId)?.sessionId;
      switchLiveTimeline(sessionId ? { deviceId, endpointId, sessionId } : null);
      // 旧通道随即关闭；同一次提交就进入连接中，避免新 Pi 的空会话提示闪现。
      if (onlineRef.current) setConnection("connecting");
    }
    resetOutputFollowing();
    const saved = activeDevice ? sessionPositions.get(`live:${activeDevice.deviceId}\u0000${endpointId}`) : undefined;
    restoreSessionPosition(saved && !("history" in saved) ? saved : null);
    selectEndpoint(endpointId);
  }, [activeDevice, activeEndpointId, endpoints, historySessions, liveEndpointSnapshot?.endpointId, onlineRef, operationNotifications, rememberSessionPosition, resetActions, resetOutputFollowing, restoreSessionPosition, selectEndpoint, selectedHistory, sessionPositions, switchLiveTimeline]);
  const sendModelsRequest = useCallback((scope: TimelineScope, channel: PeerChannel): boolean => {
    const readback = configurationReadbackRef.current;
    if (readback && (readback.channelId !== scope.channelId || readback.sessionId !== scope.sessionId)) configurationReadbackRef.current = null;
    const requestId = id();
    modelRequestRef.current = requestId;
    setModelsRequestId(requestId); setModelsStatus("loading");
    if (channel.send({ protocol_version: 2, type: "list_models", id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId })) return true;
    if (modelRequestRef.current === requestId) {
      modelRequestRef.current = null; setModelsRequestId(null); setModelsStatus("error");
      if (configurationReadbackRef.current) {
        configurationReadbackRef.current = null;
        operationNotifications.notify(getMessages().operationFeedback.configUnconfirmed, { kind: "info", sessionScoped: true });
      }
    }
    return false;
  }, [operationNotifications]);

  const confirmConfiguration = useCallback((channel: PeerChannel) => {
    const scope = timelineRuntimeRef.current.currentScope;
    if (!scope) return;
    configurationReadbackRef.current = { channelId: scope.channelId, sessionId: scope.sessionId };
    operationNotifications.notify(getMessages().operationFeedback.configChecking, { kind: "info", sessionScoped: true });
    sendModelsRequest(scope, channel);
  }, [operationNotifications, sendModelsRequest, timelineRuntimeRef]);

  const sendExtensionInfoRequest = useCallback((scope: TimelineScope, channel: PeerChannel) => {
    const requestId = id();
    extensionInfoRequestRef.current = requestId;
    if (channel.send({ protocol_version: 2, type: "extension_info_request", id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId })) return;
    if (extensionInfoRequestRef.current === requestId) extensionInfoRequestRef.current = null;
  }, []);

  const handleActionReply = useCallback((frame: Extract<ServerFrame, { type: "action_ok" | "action_error" }>, channel: PeerChannel) => {
    const pending = pendingActionRef.current;
    if (pending?.id !== frame.in_reply_to || pending.action !== frame.action) return;
    receiveAction(frame);
    if (frame.type === "action_error") {
      if (pending.action === "session_compact") {
        setCompactionActivity(null);
        operationNotifications.notify(getMessages().operationFeedback.compactIncomplete, { kind: "info" });
      } else if (pending.action === "model_set" || pending.action === "thinking_set") {
        operationNotifications.clearAction(pending.action);
        confirmConfiguration(channel);
      } else operationNotifications.show(actionErrorFeedback(pending.action));
      return;
    }
    operationNotifications.clearAction(pending.action);
    if (frame.action === "model_set" || frame.action === "thinking_set") {
      // 回执是实际值；作废切换前发出的列表，不能让旧列表覆盖新配置。
      modelRequestRef.current = null; setModelsRequestId(null); setModelsStatus("success");
      const confirming = configurationReadbackRef.current !== null;
      configurationReadbackRef.current = null;
      setReportedThinking(frame.thinking_level);
      if (frame.action === "model_set") {
        setCurrentModel(frame.model);
        const feedback = getMessages().operationFeedback;
        operationNotifications.notify(confirming ? feedback.configConfirmed(frame.model.name, frame.thinking_level) : feedback.modelUpdated(frame.model.name), { kind: confirming ? "info" : "success", sessionScoped: true });
      } else {
        const feedback = getMessages().operationFeedback;
        operationNotifications.notify(pending.requestedThinking && pending.requestedThinking !== frame.thinking_level
          ? feedback.thinkingAdjusted(frame.thinking_level) : feedback.thinkingUpdated(frame.thinking_level), { sessionScoped: true });
      }
    }
    if (frame.action === "session_compact" && frame.phase !== "accepted") {
      setCompactionActivity(frame.phase === "cancelled" ? { sessionId: timelineRuntimeRef.current.currentScope?.sessionId ?? "", status: "cancelled" } : null);
    }
  }, [confirmConfiguration, operationNotifications, pendingActionRef, receiveAction, timelineRuntimeRef]);

  const handleServerFrame = useCallback((frame: ServerFrame, context: ConnectionContext) => {
    const current = channelContextRef.current;
    if (!current || current.generation !== context.generation || current.deviceId !== context.deviceId || current.endpointId !== context.endpointId || current.runtimeInstanceId !== context.runtimeInstanceId || channelRef.current !== context.channel || relayRef.current !== context.relay) return;
    if (toolDetailsController.receive(frame)) return;
    if (frame.type === "protocol_error" && frame.code === "protocol_upgrade_required" && helloRequestRef.current !== null
      && frame.in_reply_to === helloRequestRef.current && !toolDetailsHelloRetriedRef.current) {
      toolDetailsHelloRetriedRef.current = true;
      const requestId = id();
      helloRequestRef.current = requestId;
      context.channel.send({ protocol_version: 2, type: "session_hello", id: requestId, channel_id: context.channel.channelId, tool_details: 1 });
      return;
    }
    if (fileController.receive(frame)) return;
    if (attachmentComposer.receive(frame)) return;
    if (frame.type === "protocol_error") {
      const consumed = timelineRuntimeRef.current.consumeDeliveryStatusError(frame);
      if (consumed) { applyTimelineChange(consumed); return; }
    }
    if (frame.type === "reset" || frame.type === "bye") {
      const scope = timelineRuntimeRef.current.currentScope;
      if (!scope || scope.sessionId !== frame.session_id) return;
      if (frame.type === "bye" && scope.leafId !== frame.leaf_id) return;
      operationNotifications.clearSession();
      toolDetailsController.cancel();
      if (frame.type === "reset" || frame.reason === "session_replaced") fileController.reset();
      else fileController.disconnect();
      filesReadyRef.current = false;
    }
    const recoveryAction = recoverServerFrame(frame, {
      invalidateScope: invalidateTimelineScope,
      rehello: restartSession,
      reconnect: restartSession,
      disconnect: disconnectSession,
    });
    if (recoveryAction !== "ignore") return;
    if (frame.type === "session_ready") {
      if (frame.in_reply_to !== helloRequestRef.current) return;
      helloRequestRef.current = null;
      toolDetailsSupportedRef.current = frame.tool_details === 1;
      setToolDetailsSupported(frame.tool_details === 1);
      const pending = pendingActionRef.current;
      if (pending && pending.action !== "session_new" && pending.sessionId !== frame.session_id) resetActions();
      setCompactionActivity((current) => current?.sessionId === frame.session_id ? current : null);
      observeSession(frame.session_id, false);
      if (stopRequestRef.current && stopRequestRef.current.sessionId !== frame.session_id) setStopRequest(null);
      const scope: TimelineScope = { deviceId: context.deviceId, endpointId: context.endpointId, runtimeInstanceId: context.runtimeInstanceId, sessionId: frame.session_id, leafId: frame.leaf_id, selfSenderRef: frame.self_sender_ref, channelId: context.channel.channelId };
      // 同一 Pi 进程换了会话（如执行 /new）：主区跟随新会话，并在开头标出切换。
      const runtimeKey = `${context.deviceId}\u0000${context.endpointId}\u0000${context.runtimeInstanceId}`;
      const previousSession = lastSessionByRuntimeRef.current.get(runtimeKey);
      lastSessionByRuntimeRef.current.set(runtimeKey, frame.session_id);
      setDraftSessions((current) => current[runtimeKey] === frame.session_id ? current : { ...current, [runtimeKey]: frame.session_id });
      if (previousSession !== undefined && previousSession !== frame.session_id) {
        operationNotifications.clearSession();
        setSessionSwitched(true);
      }
      emptySessionFocusRef.current = frame.head_seq === 0 ? `${context.deviceId}\u0000${context.endpointId}\u0000${frame.session_id}` : null;
      // 握手回调可同步触发附件交接；在 React 提交恢复 flags 前先关闭入口。
      sendReadyRef.current = false;
      startLive({ scope, headSeq: frame.head_seq, send: (request) => context.channel.send(request), onHistoryChanged: () => { void refreshHistory(); }, onBranchMismatch: () => {
        // 与收到 reset(branch_changed) 相同：撤下当前投影并重新握手，按权威分支整段替换本地记录。
        if (channelContextRef.current?.generation !== context.generation) return;
        fileController.reset();
        filesReadyRef.current = false;
        invalidateTimelineScope();
        restartSession();
      } });
      // 无批次时允许先发现能力；原批次的恢复交接等 React 提交真实就绪后再尝试。
      connectionRef.current = "online";
      connectReadyAttachments();
      setLiveSession({ deviceId: context.deviceId, endpointId: context.endpointId, sessionId: frame.session_id });
      rememberSessionDetails(scope);
      sendModelsRequest(scope, context.channel);
      sendExtensionInfoRequest(scope, context.channel);
      finishRetry();
      setConnectionFeedback(null);
      setConnection("online");
      return;
    }
    if (frame.type === "extension_info") {
      if (frame.in_reply_to !== extensionInfoRequestRef.current) return;
      extensionInfoRequestRef.current = null;
      setExtensionVersion(frame.version);
      return;
    }
    if (frame.type === "protocol_error" && frame.in_reply_to === extensionInfoRequestRef.current) {
      // 诊断请求失败只影响版本展示，不能干扰已建立的会话。
      extensionInfoRequestRef.current = null;
      return;
    }
    if (frame.type === "models_list") {
      if (frame.in_reply_to !== modelRequestRef.current) return;
      modelRequestRef.current = null; setModelsRequestId(null); setModelsStatus("success");
      const currentModelFromEndpoint = frame.current ?? resolveEndpointModel(frame.models, activeEndpointModelRef.current);
      setModels(frame.models); setCurrentModel(currentModelFromEndpoint ?? null); setReportedThinking(frame.thinking_level);
      const readback = configurationReadbackRef.current;
      configurationReadbackRef.current = null;
      const scope = timelineRuntimeRef.current.currentScope;
      if (readback && readback.channelId === context.channel.channelId && readback.sessionId === scope?.sessionId) {
        const feedback = getMessages().operationFeedback;
        // 缺少 wire current 不能用 endpoint 旧值冒充已确认配置。
        operationNotifications.notify(frame.current ? feedback.configConfirmed(frame.current.name, frame.thinking_level) : feedback.configUnconfirmed, { kind: "info", sessionScoped: true });
      }
      const pending = pendingActionRef.current;
      if (pending?.phase === "unknown" && (pending.action === "model_set" || pending.action === "thinking_set")) setPendingAction(null);
      return;
    }
    if (frame.type === "action_ok" || frame.type === "action_error") { handleActionReply(frame, context.channel); return; }
    if (frame.type === "protocol_error" && frame.in_reply_to) {
      if (frame.in_reply_to === stopRequestRef.current?.id) {
        setStopRequest(null); operationNotifications.show("stop-send-failed"); return;
      }
      if (frame.in_reply_to === modelRequestRef.current) {
        modelRequestRef.current = null; setModelsRequestId(null); setModelsStatus("error");
        if (configurationReadbackRef.current) {
          configurationReadbackRef.current = null;
          operationNotifications.notify(getMessages().operationFeedback.configUnconfirmed, { kind: "info", sessionScoped: true });
        }
        return;
      }
      const pending = pendingActionRef.current;
      if (frame.in_reply_to === pending?.id) {
        if (pending.action === "session_compact") setCompactionActivity(null);
        setPendingAction(null);
        if (pending.action === "model_set" || pending.action === "thinking_set") {
          operationNotifications.clearAction(pending.action);
          confirmConfiguration(context.channel);
        } else operationNotifications.show(actionErrorFeedback(pending.action));
        return;
      }
    }
    if (frame.type === "cancelled") {
      const stop = stopRequestRef.current;
      if (stop && frame.in_reply_to === stop.id && stop.sessionId === timelineRuntimeRef.current.currentScope?.sessionId) {
        setStopRequest({ ...stop, accepted: true });
        operationNotifications.clearStop();
      }
      // 受理不等于该轮已结束；只在正式 run_end 后解除等待。
      return;
    }
    if (frame.type === "compaction_activity") {
      const scope = timelineRuntimeRef.current.currentScope;
      if (scope?.sessionId !== frame.session_id || scope.leafId !== frame.leaf_id) return;
      if (frame.status === "running") {
        if (pendingActionRef.current?.action !== "session_compact") remoteCompactionPresentationRef.current = false;
        setCompactionActivity({ sessionId: frame.session_id, status: "running" });
      } else if (!remoteCompactionPresentationRef.current) {
        // 成功压缩会重建时间线，旧终态提示随之消失；失败/取消/待确认保留。
        if (frame.status === "completed") setCompactionNotices((current) => current.filter((notice) => notice.sessionId !== frame.session_id));
        setCompactionActivity(frame.status === "completed" ? null : { sessionId: frame.session_id, status: frame.status });
      }
      return;
    }
    if (historyLoaderRef.current?.receive(frame)) return;
    receiveTimelineFrame(frame, {
      runtime: timelineRuntimeRef.current, fragmentAssemblerRef, isCurrent: () => channelRef.current === context.channel,
      applyTimelineChange: (change, reset) => {
        let applied = change;
        if (change.cancelledQueued?.length) {
          const restored = restoreQueuedRef.current(change.cancelledQueued);
          const ids = change.cancelledQueued.map((item) => item.clientRequestId);
          applied = restored ? timelineRuntimeRef.current.confirmCancelledRestore(ids) : timelineRuntimeRef.current.keepCancelledRestore();
        }
        applyTimelineChange(applied, reset);
        const stop = stopRequestRef.current;
        if (stop && stopHasEnded(stop, applied.items)) { setStopRequest(null); operationNotifications.clearStop(); }
        connectReadyAttachments();
      },
      receiveRealtimeOutput, setError: reportSessionFailure, setLastSyncedAt, onHistoryChanged: refreshHistory,
    });
  }, [toolDetailsController, attachmentComposer, connectReadyAttachments, fileController, filesReadyRef, applyTimelineChange, confirmConfiguration, disconnectSession, finishRetry, fragmentAssemblerRef, handleActionReply, historyLoaderRef, invalidateTimelineScope, observeSession, operationNotifications, pendingActionRef, receiveRealtimeOutput, refreshHistory, relayRef, rememberSessionDetails, reportSessionFailure, resetActions, restartSession, sendExtensionInfoRequest, sendModelsRequest, setLastSyncedAt, setPendingAction, setStopRequest, startLive, stopRequestRef, timelineRuntimeRef]);

  // bridge、草稿范围与就绪 refs 均已在前面的 layout effects 更新，允许能力回调同步完成原批次交接。
  useLayoutEffect(() => { connectReadyAttachments(); }, [connectReadyAttachments, sendReady, connection, liveSession]);

  useEffect(() => {
    if (!modelsRequestId) return;
    const timer = window.setTimeout(() => {
      if (modelRequestRef.current !== modelsRequestId) return;
      modelRequestRef.current = null; setModelsRequestId(null); setModelsStatus("error");
      if (configurationReadbackRef.current) {
        configurationReadbackRef.current = null;
        operationNotifications.notify(getMessages().operationFeedback.configUnconfirmed, { kind: "info", sessionScoped: true });
      }
    }, OPERATION_CONFIRMATION_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [modelsRequestId, operationNotifications]);
  useEffect(() => {
    const scope = timelineRuntimeRef.current.currentScope;
    if (scope && connection === "online" && !catchingUp && !catchupFailed && !reconnectPhase) observeSession(scope.sessionId, true);
  }, [catchingUp, catchupFailed, connection, liveSession, observeSession, reconnectPhase, timelineRuntimeRef]);
  useEffect(() => {
    if (stopRequest && stopHasEnded(stopRequest, timelineItems)) { setStopRequest(null); operationNotifications.clearStop(); }
  }, [operationNotifications, setStopRequest, stopRequest, timelineItems]);
  useEffect(() => {
    const model = activeEndpoint?.model;
    if (activeEndpointModelRef.current === model && activeEndpointThinkingRef.current === activeEndpoint?.thinking) return;
    activeEndpointModelRef.current = model;
    activeEndpointThinkingRef.current = activeEndpoint?.thinking;
    // 会话尚未就绪时，session_ready 的首个请求会读取当前模型。
    if (connection !== "online") return;
    const scope = timelineRuntimeRef.current.currentScope;
    const channel = channelRef.current;
    if (!scope || !channel) return;
    sendModelsRequest(scope, channel);
  }, [activeEndpoint?.model, activeEndpoint?.thinking, connection, sendModelsRequest, timelineRuntimeRef]);

  useEffect(() => {
    let cancelled = false;
    const database = getPwaDatabase();
    const removeFailure = database.onOpenFailure((failure) => { if (!cancelled) { setStartupError(describeStartupFailure(failure)); setStartupState("error"); } });
    void (async () => {
      assertBrowserCapabilities();
      const deploymentDefault = readDefaultRelayUrl();
      const db = await openPwaDatabase();
      const storedIdentity = await db.identities.get("owner");
      const nextIdentity = storedIdentity ? { privateKey: fromStoredKey(storedIdentity.secretKey), publicKey: fromStoredKey(storedIdentity.publicKey) } : await generateOwnerKeyPair();
      if (!storedIdentity) await db.identities.put({ id: "owner", publicKey: toStoredKey(nextIdentity.publicKey), secretKey: toStoredKey(nextIdentity.privateKey), createdAt: Date.now() });
      const [storedDevices, storedRelay, storedActive] = await Promise.all([listPwaDevices(), db.settings.get(RELAY_SETTING), db.settings.get(ACTIVE_DEVICE_SETTING)]);
      if (cancelled) return;
      setIdentity(nextIdentity);
      setDevices(storedDevices);
      setDefaultRelayUrl(deploymentDefault);
      setRelayUrl(migrateLegacyDefaultRelay(storedRelay?.value, LEGACY_DEFAULT_RELAYS, deploymentDefault));
      restoreActiveDevice(storedDevices.find((device) => device.id === storedActive?.value)?.id ?? storedDevices[0]?.id ?? null);
      setStartupState("ready");
    })().catch((failure: unknown) => { if (!cancelled) { setStartupError(describeStartupFailure(failure)); setStartupState("error"); } });
    return () => { cancelled = true; removeFailure(); };
  }, [restoreActiveDevice]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const sessionIdentity = sessionDeviceId && sessionEndpointId && sessionRuntimeInstanceId
        ? `${sessionDeviceId}\u0000${sessionEndpointId}\u0000${sessionRuntimeInstanceId}`
        : null;
      if (sessionIdentityRef.current !== sessionIdentity) {
        operationNotifications.clearSession();
        sessionRecoveryStateRef.current.replacementBye();
        sessionIdentityRef.current = sessionIdentity;
        resetActions(); setCompactionActivity(null); remoteCompactionPresentationRef.current = false;
        setModels([]); setCurrentModel(null); setReportedThinking(null); setModelsStatus("idle");
      }
      clearSessionConnection();
      if (sessionRecoveryStateRef.current.isTerminal) { setConnection("offline"); return; }
      if (!sessionDeviceId || !sessionEndpointId || !sessionRuntimeInstanceId || !sessionOnline || !identity) {
        setConnection((current) => {
          if (!onlineRef.current) return "no_network";
          if (current === "retrying" || current === "connecting" || retryPendingRef.current) return current;
          return "offline";
        });
        return;
      }
      const relay = relayRef.current;
      if (!relay || relay.state !== "open") { setConnection(onlineRef.current ? "connecting" : "no_network"); return; }
      const generation = connectionGenerationRef.current;
      const contextBase = { generation, deviceId: sessionDeviceId, endpointId: sessionEndpointId, runtimeInstanceId: sessionRuntimeInstanceId, relay };
      let channel: PeerChannel | null = null;
      channel = new PeerChannel({ relay, endpoint: contextBase, channelId: sessionChannelIdRef.current, onFrame: (frame) => {
        if (channel) handleServerFrame(frame, { ...contextBase, channel });
      }, onMalformed: reportProtocolFailure });
      channelRef.current = channel;
      channelContextRef.current = { ...contextBase, channel };
      setConnection("connecting");
      sessionRecoveryStateRef.current.beginConnection();
      const helloId = id();
      helloRequestRef.current = helloId;
      if (!channel.send({ protocol_version: 2, type: "session_hello", id: helloId, channel_id: channel.channelId })) {
        setConnection("offline");
        closeRelayIntentionally("Session channel send failed");
      }
    });
    return () => {
      cancelled = true;
      const channel = channelRef.current;
      toolDetailsController.disconnect();
      fileController.disconnect();
      filesReadyRef.current = false;
      channel?.close();
      disconnectTimeline();
      attachmentComposer.disconnect();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [toolDetailsController, attachmentComposer, fileController, filesReadyRef, clearSessionConnection, closeRelayIntentionally, disconnectTimeline, handleServerFrame, identity, onlineRef, operationNotifications, relayConnectionGeneration, relayRef, reportProtocolFailure, sessionDeviceId, sessionEndpointId, sessionOnline, sessionRestartToken, sessionRuntimeInstanceId, startupState, resetActions]);

  const sendMessage = useCallback(() => {
    const scope = timelineRuntimeRef.current.currentScope; const channel = channelRef.current; const text = draft.trim();
    if (!sendReadyRef.current || timelineRuntimeRef.current.replacing) return;
    if ((!text && attachmentComposer.snapshot().items.length === 0) || !scope || !channel || connectionRef.current !== "online" || selectedHistoryRef.current !== null || channel.closed || attachmentComposer.snapshot().active || pendingActionRef.current?.action === "session_new") return;
    setError(null);
    if (attachmentComposer.snapshot().items.length) {
      attachmentComposer.connect(scope, (frame) => channel.send(frame));
      attachmentComposer.start(text, { draftKey, draftVersion: draftVersionRef.current });
      return;
    }
    let prepareReported = false;
    const outcome = submitMessage({ text, scope, channel, online: connectionRef.current === "online",
      historyOpen: selectedHistoryRef.current !== null, newSessionPending: false,
      runtime: timelineRuntimeRef.current, queueExpected: piWorkingRef.current, following: followingNow,
      capture: captureOwnSend, follow: followOwnSend, apply: applyTimelineChange,
      onPrepareError: (error) => { prepareReported = true; reportSessionFailure(error instanceof PendingCapacityError ? error.message
        : error && typeof error === "object" && "invalidPayload" in error
          ? "This message is too large or invalid to send. Shorten it and try again."
          : "Could not send this message. Try again.", "message-send"); } });
    if (outcome === "handled") setDraftFor(draftKey, "");
    else if (!prepareReported) reportSessionFailure("Could not send this message. Try again.", "message-send");
  }, [applyTimelineChange, attachmentComposer, captureOwnSend, draft, draftKey, followOwnSend, followingNow, pendingActionRef, reportSessionFailure, setDraftFor, timelineRuntimeRef]);
  const deliveryQueriesRef = useRef<{ channel: PeerChannel | null; sessionId: string | null; checked: Map<string, string> }>({ channel: null, sessionId: null, checked: new Map() });
  // 查询超时后的自动重查到期时由定时器递增，重新运行下方的自动查询。
  const [deliveryRetryTick, setDeliveryRetryTick] = useState(0);
  const checkDeliveryStatus = useCallback((clientRequestId: string) => {
    const channel = channelRef.current;
    if (!channel || channel.closed || connectionRef.current !== "online" || selectedHistoryRef.current || pendingActionRef.current?.action === "session_new") return;
    const query = timelineRuntimeRef.current.requestDeliveryStatus(clientRequestId);
    if (!query) return;
    const pending = timelineRuntimeRef.current.findPendingOrUnknown(clientRequestId);
    if (pending) deliveryQueriesRef.current.checked.set(clientRequestId, JSON.stringify([pending.requestId, pending.queuedActionRequestId ?? null]));
    applyTimelineChange(query.change);
    if (!channel.send(query.frame)) applyTimelineChange(timelineRuntimeRef.current.clearDeliveryStatusQuery(clientRequestId));
  }, [applyTimelineChange, pendingActionRef, timelineRuntimeRef]);
  const retryFailed = useCallback((clientRequestId: string) => {
    const runtime = timelineRuntimeRef.current;
    const scope = runtime.currentScope;
    const channel = channelRef.current;
    if (!scope || !channel || channel.closed || connectionRef.current !== "online" || selectedHistoryRef.current || pendingActionRef.current?.action === "session_new") return;
    const pending = runtime.findPendingOrUnknown(clientRequestId);
    if (!pending || pending.delivery !== "failed" || !pending.deliveryFailure?.retryable) return;
    if (pending.attachments?.length) {
      const decision = attachmentRetryDecision({ attachments: pending.attachments, target: attachmentTargetKey(scope),
        composer: attachmentComposer.snapshot(), leases: attachmentLeasesRef.current });
      if (decision === "wait") return;
      if (decision === "invalid") {
        applyTimelineChange(runtime.markDeliveryFailed(clientRequestId, "invalid_target", false));
        return;
      }
    }
    const retry = runtime.retryFailed(clientRequestId);
    if (!retry) return;
    applyTimelineChange(retry.change);
    if (!channel.send(retry.frame)) applyTimelineChange(runtime.markDeliveryFailed(clientRequestId, "transport_unavailable", true));
  }, [applyTimelineChange, attachmentComposer, pendingActionRef, timelineRuntimeRef]);
  useEffect(() => {
    const channel = channelRef.current;
    const runtime = timelineRuntimeRef.current;
    const sessionId = runtime.currentScope?.sessionId ?? null;
    if (connection !== "online") { deliveryQueriesRef.current = { channel: null, sessionId: null, checked: new Map() }; return; }
    if (!channel || !queueSnapshotReady || selectedHistory || catchingUp || catchupFailed || reconnectPhase || pendingAction?.action === "session_new") return;
    if (deliveryQueriesRef.current.channel !== channel || deliveryQueriesRef.current.sessionId !== sessionId) {
      deliveryQueriesRef.current = { channel, sessionId, checked: new Map() };
    }
    const checked = deliveryQueriesRef.current.checked;
    const now = Date.now();
    let nextRetryAt: number | null = null;
    for (const pending of runtime.pendingItems) {
      if (pending.scopeInvalid === true || pending.delivery !== "unknown_delivery" || pending.statusQuery || pending.statusQueryUnsupported
        || pending.messageId || pending.senderRef !== runtime.currentScope?.selfSenderRef) continue;
      if (checked.get(pending.clientRequestId) === JSON.stringify([pending.requestId, pending.queuedActionRequestId ?? null])) {
        // 已查过的消息只在上次查询超时、未获任何答复时按退避自动重查。
        const retryAt = runtime.deliveryQueryRetryAt(pending.clientRequestId);
        if (retryAt === null) continue;
        if (retryAt > now) { nextRetryAt = nextRetryAt === null ? retryAt : Math.min(nextRetryAt, retryAt); continue; }
      }
      checkDeliveryStatus(pending.clientRequestId);
    }
    if (nextRetryAt === null) return;
    const timer = window.setTimeout(() => setDeliveryRetryTick((tick) => tick + 1), nextRetryAt - now);
    return () => window.clearTimeout(timer);
  }, [catchingUp, catchupFailed, checkDeliveryStatus, connection, deliveryRetryTick, pendingAction?.action, queueSnapshotReady, reconnectPhase, selectedHistory, timelineItems, timelineRuntimeRef]);
  useEffect(() => {
    if (connection !== "online") return;
    const runtime = timelineRuntimeRef.current;
    const deadline = runtime.nextDeliveryDeadline();
    if (deadline === null) return;
    const timer = window.setTimeout(() => {
      runtime.expireDeliveryStatusQueries();
      applyTimelineChange(runtime.expireDeliveryConfirmations());
    }, Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [applyTimelineChange, connection, timelineItems, timelineRuntimeRef]);
  // 阅读意图由视口在前插前登记（内容不足一屏的补页保持跟随），这里只做连接门禁。
  const loadEarlier = useCallback(() => {
    if (connection !== "online" || loadingEarlier) return;
    loadEarlierTimeline();
  }, [connection, loadEarlierTimeline, loadingEarlier]);
  const stopCurrentTask = useCallback(() => {
    const scope = timelineRuntimeRef.current.currentScope; const channel = channelRef.current;
    if (!scope || !channel || stopRequestRef.current || connectionRef.current !== "online") return;
    // 以权威条目确定当前轮：显示队列交接期间，显示快照可能仍停在上一轮。
    const groupId = currentRunGroup(timelineRuntimeRef.current.currentItems());
    if (!groupId || timelineRuntimeRef.current.formalEvents().some((event) => event.kind === "run_end" && event.group_id === groupId)) return;
    const requestId = id();
    setStopRequest({ id: requestId, groupId, sessionId: scope.sessionId, leafId: scope.leafId, startedAt: Date.now(), unknown: false });
    if (!channel.send({ protocol_version: 2, type: "cancel", id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId, group_id: groupId })) {
      setStopRequest(null); operationNotifications.show("stop-send-failed");
    }
  }, [operationNotifications, setStopRequest, stopRequestRef, timelineRuntimeRef]);
  const sendCommandAction = useCallback((request: ComposerCommandRequest): boolean => {
    const scope = timelineRuntimeRef.current.currentScope; const channel = channelRef.current;
    if (!scope || !channel || connection !== "online" || pendingActionRef.current) return false;
    if (request.action === "session_new") setError(null);
    const requestId = id();
    let frame: ClientFrame;
    if (request.action === "session_new" || request.action === "session_compact") frame = { protocol_version: 2, type: request.action, id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId };
    else if (request.action === "model_set") frame = { protocol_version: 2, type: "model_set", id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId, provider: request.provider, model_id: request.modelId };
    else {
      const thinking = request as Extract<ComposerCommandRequest, { action: "thinking_set" }>;
      frame = { protocol_version: 2, type: "thinking_set", id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId, level: thinking.level };
    }
    setCompactionActivity(null);
    if (request.action === "session_compact") remoteCompactionPresentationRef.current = true;
    if (request.action === "model_set" || request.action === "thinking_set") {
      configurationReadbackRef.current = null;
      operationNotifications.clearSession({ toastsOnly: true });
      modelRequestRef.current = null; setModelsRequestId(null);
    }
    setPendingAction({ id: requestId, sessionId: scope.sessionId, action: request.action, phase: "pending", startedAt: Date.now(), ...(request.action === "thinking_set" ? { requestedThinking: request.level } : {}), ...(request.action === "session_new" ? { projection: timelineItemsRef.current } : {}) });
    if (!channel.send(frame)) {
      setPendingAction(null);
      if (request.action === "session_compact") remoteCompactionPresentationRef.current = false;
      if (request.action !== "session_new") operationNotifications.show(actionSendFailureFeedback(request.action));
      return false;
    }
    return true;
  }, [connection, operationNotifications, pendingActionRef, setPendingAction, timelineRuntimeRef]);
  const requestModels = useCallback(() => {
    const scope = timelineRuntimeRef.current.currentScope; const channel = channelRef.current;
    if (!scope || !channel || connection !== "online") return;
    sendModelsRequest(scope, channel);
  }, [connection, sendModelsRequest, timelineRuntimeRef]);
  const persistPairedDevice = useCallback(async ({ device, endpointId }: DevicePairingResult) => {
    const db = getPwaDatabase();
    await db.transaction("rw", [db.devices, db.settings], async () => {
      await Promise.all([
        db.devices.put(device),
        db.settings.put({ key: activeEndpointSettingKey(device.id), value: endpointId }),
      ]);
    });
    setDevices(await listPwaDevices());
    activatePairedDevice(device.id, endpointId);
    operationNotifications.notify(getMessages().pairing.paired(displayDevice(device)));
  }, [activatePairedDevice, operationNotifications]);
  const getOwnerRelay = useCallback(() => relayRef.current, [relayRef]);
  const pairing = useDevicePairing({ getOwnerRelay, relayUrl, onPaired: persistPairedDevice });
  const openPairing = () => {
    const focusOrigin = focusedElement();
    setPairingFocusOrigin(focusOrigin);
    if (focusOrigin?.closest(".pwa-session-sheet") || document.querySelector(".pwa-session-sheet")) {
      requestAnimationFrame(pairing.open);
      return;
    }
    pairing.open();
  };
  const removePairing = useCallback(async (device: PwaDeviceRecord) => {
    if (isActiveDevice(device.id)) clearSessionConnection();
    await invalidatePersistence();
    await invalidateSessionDetails();
    await removePwaDeviceData(device.deviceId, device.id, activeEndpointSettingKey(device.id));
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !draftBelongsToDevice(key, device.deviceId))));
    const remaining = await listPwaDevices(); setDevices(remaining);
    if (isActiveDevice(device.id)) selectDevice(remaining[0]?.id ?? null);
  }, [clearSessionConnection, invalidatePersistence, invalidateSessionDetails, isActiveDevice, selectDevice]);
  const clearLocalData = useCallback(async () => {
    await invalidatePersistence();
    await invalidateSessionDetails();
    await clearPwaData();
    clearStoredDrafts();
    sessionPositions.clear();
  }, [invalidatePersistence, invalidateSessionDetails, sessionPositions]);
  const saveDeviceNickname = useCallback(async (device: PwaDeviceRecord, nickname: string) => { await getPwaDatabase().devices.put({ ...device, nickname }); setDevices(await listPwaDevices()); }, []);
  const saveRelayUrl = useCallback(async (value: string) => {
    const normalized = value.trim().replace(/\/$/, "") || defaultRelayUrl;
    const updated = devices.map((device) => ({ ...device, relayUrl: normalized }));
    await Promise.all([getPwaDatabase().settings.put({ key: RELAY_SETTING, value: normalized }), getPwaDatabase().devices.bulkPut(updated)]);
    setRelayUrl(normalized); setDevices(updated);
    operationNotifications.notify(getMessages().settings.saved);
  }, [defaultRelayUrl, devices, operationNotifications]);
  // 撤回的排队消息回到当前输入区：空草稿直接填入，已有草稿换行追加；图片只在输入区没有附件时回填。
  const restoreQueuedMessages = useCallback((cancellations: readonly QueuedCancellation[]): boolean => {
    if (!draftKey) return false;
    const restored = cancellations.map((item) => item.text).filter((text) => text.trim()).join("\n");
    if (restored) {
      draftVersionRef.current += 1;
      setDrafts((current) => {
        const existing = current[draftKey] ?? "";
        return { ...current, [draftKey]: existing.trim() ? `${existing}\n${restored}` : restored };
      });
    }
    const attachments = cancellations.flatMap((item) => item.attachments ?? []);
    if (attachments.length > 0 && !attachmentComposer.restoreAttachments(attachments)) return false;
    const image = cancellations.find((item) => item.images?.length)?.images?.[0];
    if (!image || attachmentComposer.snapshot().items.length) return true;
    try {
      addAttachmentFiles([new File([new Uint8Array(decodeBase64(image.data))], getMessages().composer.imageAttachment, { type: image.mime })]);
    } catch { /* 旧图片不能还原时仍保留文字。 */ }
    return true;
  }, [addAttachmentFiles, attachmentComposer, draftKey]);
  useLayoutEffect(() => { restoreQueuedRef.current = restoreQueuedMessages; }, [restoreQueuedMessages]);
  const { requestConfirmation, closeBackgroundOverlay, finishConfirmationTransition } = useConfirmationOverlay(setConfirmAction, setConfirmError, confirmPendingRef);
  const confirmRequestedAction = useCallback(async () => {
    if (!confirmAction) return;
    if (confirmAction.kind !== "remove-pairing" || isActiveDevice(confirmAction.device.id)) {
      attachmentComposer.cancelIntent();
      if (confirmAction.kind === "new-session") fileController.cancel();
      else { fileController.reset(); filesReadyRef.current = false; }
    }
    await runConfirmAction(confirmAction, { startNewSession: () => sendCommandAction({ action: "session_new" }), removePairing, invalidateConnection: clearSessionConnection, clearLocalData, reload: reloadWorkspace }, { pendingRef: confirmPendingRef, setPending: setConfirmPending, setError: setConfirmError, onSuccess: () => setConfirmAction(null) });
  }, [attachmentComposer, fileController, filesReadyRef, clearLocalData, clearSessionConnection, confirmAction, isActiveDevice, removePairing, sendCommandAction]);
  const navigate = (next: () => void) => {
    // 真正切换时新内容在同一次提交中换上；需要确认时在确认框下方恢复原会话。
    switchOut.settle();
    const uploads = attachmentComposer.snapshot().active;
    const files = fileController.snapshot().active;
    const switchTarget = () => { fileController.reset(); filesReadyRef.current = false; next(); };
    if (uploads || files) requestConfirmation({ kind: "leave-attachments", next: switchTarget, uploads, files });
    else switchTarget();
  };
  const selectLiveEndpoint = (endpointId: string) => {
    if (selectedHistory !== null || endpointId !== activeEndpointId) switchOut.run(() => navigate(() => openLiveEndpoint(endpointId)));
    else switchOut.settle();
  };
  const selectHistory = (history: TimelineSessionSummary) => {
    if (selectedHistory?.id !== history.id) switchOut.run(() => navigate(() => openHistory(history)));
    else switchOut.settle();
  };
  const switchesTo = (target: NavigationSwitchTarget) => target.kind === "device"
    ? target.deviceId !== activeDeviceId
    : target.kind === "endpoint" ? selectedHistory !== null || target.endpointId !== activeEndpointId : selectedHistory?.id !== target.historyId;
  const onlinePis = useMemo(() => activePis.filter((endpoint) => endpoint.online !== false).sort((left, right) => displayPi(left).localeCompare(displayPi(right))), [activePis]);
  const placeholderKind: WorkspacePlaceholderKind = !activeDevice ? "choose-computer" : !snapshotReady ? "checking" : onlinePis.length === 0 ? "no-pi" : onlinePis.length > 1 ? "choose-pi" : "opening";
  // 在线 Pi 的当前会话只出现在「在线 Pi」分组：已握手的当前 Pi 按会话身份隐藏；其他 Pi 和切换中尚未握手的目标
  // 暂时隐藏本浏览器最近更新的一条历史。Pi 退出或切换会话后，这些记录照常回到本地历史；正在阅读的历史始终保留。
  const selectedEndpointId = activeEndpoint?.endpointId ?? null;
  const navigationHistory = useMemo(() => {
    const onlineEndpointIds = new Set(onlinePis.map((endpoint) => endpoint.endpointId));
    if (onlineEndpointIds.size === 0) return historySessions;
    const latestByEndpoint = new Map<string, TimelineSessionSummary>();
    for (const session of historySessions) {
      const latest = latestByEndpoint.get(session.endpointId);
      if (!latest || session.updatedAt > latest.updatedAt) latestByEndpoint.set(session.endpointId, session);
    }
    return historySessions.filter((session) => {
      if (session.id === selectedHistory?.id || !onlineEndpointIds.has(session.endpointId)) return true;
      if (session.endpointId === selectedEndpointId && (!liveSession || liveSession.deviceId !== session.deviceId || liveSession.endpointId === session.endpointId)) {
        return !(liveSession?.deviceId === session.deviceId && liveSession.endpointId === session.endpointId && liveSession.sessionId === session.sessionId);
      }
      // 目标握手前沿用其他在线 Pi 的规则，避免最近历史短暂出现又消失。
      return latestByEndpoint.get(session.endpointId) !== session;
    });
  }, [historySessions, liveSession, onlinePis, selectedEndpointId, selectedHistory?.id]);
  const sessionLoading = selectedHistory === null && activeDevice !== null && displayEndpoint !== null && timelineItems.length === 0 && (connection === "connecting" || catchingUp);
  const focusEmptySession = useCallback(() => {
    const scope = timelineRuntimeRef.current.currentScope;
    const sessionKey = scope ? `${scope.deviceId}\u0000${scope.endpointId}\u0000${scope.sessionId}` : null;
    if (!sessionKey || sessionKey === lastFocusedSessionRef.current || connection !== "online" || selectedHistory !== null || pendingAction?.action === "session_new") return;
    // 弹窗退出后才聚焦新会话；连接／会话变化时仍须重新核对身份和空态。
    if (emptySessionFocusRef.current !== sessionKey || timelineItems.length !== 0 || window.matchMedia(MOBILE_LAYOUT_QUERY).matches) return;
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    const input = document.querySelector<HTMLTextAreaElement>(".pwa-composer-input:not(:disabled)");
    if (!input) return;
    input.focus({ preventScroll: true });
    if (document.activeElement === input) lastFocusedSessionRef.current = sessionKey;
  }, [connection, pendingAction?.action, selectedHistory, timelineItems, timelineRuntimeRef]);
  useEffect(() => {
    const frame = requestAnimationFrame(focusEmptySession);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    if (!dialog) return () => cancelAnimationFrame(frame);
    let retryFrame = 0;
    const observer = new MutationObserver(() => {
      if (dialog.isConnected) return;
      observer.disconnect();
      retryFrame = requestAnimationFrame(focusEmptySession);
    });
    observer.observe(dialog.closest(".pwa-root") ?? document.body, { childList: true, subtree: true });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(retryFrame); observer.disconnect(); };
  }, [focusEmptySession]);
  // 未打开会话时的等待用主区骨架屏；已打开会话时骨架行显示在消息列表内，列表保持挂载以免打断滚动锚点。
  const mainLoading = selectedHistory === null && devices.length > 0 && !displayEndpoint && (placeholderKind === "checking" || placeholderKind === "opening");
  const skeletonVisible = useDelayedVisibility(mainLoading);
  const sessionSkeletonVisible = useDelayedVisibility(sessionLoading);
  // 未打开会话时（没有在线 Pi、等待选择或等待快照），标题区与连接提示条只反映 Relay 与网络；没有可连接的 Pi 不是连接故障。
  const liveSessionShown = selectedHistory === null && Boolean(activeDevice && displayEndpoint);
  const displayConnection = liveSessionShown ? connection : relayStatus;
  const rawConnectionIssue: ConnectionIssueKind | null = selectedHistory !== null || exitedDisplay !== null
    ? null
    : displayConnection === "no_network"
      ? "network"
      : displayConnection === "offline" || displayConnection === "retrying" || displayConnection === "connecting" && connectionFeedback
        ? "relay"
        : liveSessionShown ? connectionFeedback : null;
  // 连接问题在输入区提示行（未打开会话时为主区空态）呈现（ADR-20261105）：3 秒内的抖动不提示，
  // 3 秒后说明正在重连，10 秒后说明原因并提供立即重试；标题区不再显示连接状态。
  const connectionReconnectingDue = useDelayedVisibility(rawConnectionIssue !== null, CONNECTION_HINT_TIMING.reconnectingMs, 0);
  const connectionRetryDue = useDelayedVisibility(rawConnectionIssue !== null, CONNECTION_HINT_TIMING.retryMs, 0);
  const connectionIssue = connectionReconnectingDue ? rawConnectionIssue : null;
  const connectionStage: ConnectionHintStage | null = connectionIssue === null ? null : connectionRetryDue ? "retry" : "reconnecting";
  // 曾经在线后断线、且出现过「无法连接」提示时，恢复连接后以 Toast 提示「连接已恢复」；首次连接不提示。
  const connectionIssueShownRef = useRef(false);
  const everOnlineRef = useRef(false);
  const connectionIssueVisible = connectionRetryDue && rawConnectionIssue !== null;
  useEffect(() => {
    if (connectionIssueVisible) { if (everOnlineRef.current) connectionIssueShownRef.current = true; return; }
    if (displayConnection === "online") everOnlineRef.current = true;
    if (connectionIssueShownRef.current && displayConnection === "online") {
      connectionIssueShownRef.current = false;
      operationNotifications.notify(getMessages().connection.restored);
    }
  }, [connectionIssueVisible, displayConnection, operationNotifications]);
  const { completedEndpointIds, completedDeviceIds } = useBackgroundCompletionNotices({
    devices, endpoints, snapshotDeviceIds, viewingEndpoint: selectedHistory === null ? activeEndpoint : null,
  });
  const deviceActivity = useMemo(() => deriveDeviceActivity(devices, endpoints, completedDeviceIds), [completedDeviceIds, devices, endpoints]);
  const newSessionPending = pendingAction?.action === "session_new";
  const visibleTimelineItems = newSessionPending ? pendingAction.projection ?? timelineItems : timelineItems;
  const compactingNow = displayEndpoint !== null && exitedDisplay === null
    && (compactionActivity?.status === "running" || (pendingAction?.action === "session_compact" && pendingAction.phase !== "unknown"));
  // 压缩已经在消息末尾（进行中或终态）时，不再用「请求未确认」占用输入区提示，避免同一件事出现两处。
  const compactionVisible = compactingNow || (pendingAction?.action === "session_compact" && compactionActivity !== null);
  const operationNotice = useMemo(() => compactionVisible ? null : operationHint(pendingAction, stopRequest, t.operationFeedback), [compactionVisible, pendingAction, stopRequest, t.operationFeedback]);
  const changeComposerDraft = useCallback((value: string) => {
    draftVersionRef.current += 1;
    setDraftFor(draftKey, value);
  }, [draftKey, setDraftFor]);
  const requestNewSession = useCallback(() => requestConfirmation({ kind: "new-session" }), [requestConfirmation]);
  const compactCurrentSession = useCallback(() => { sendCommandAction({ action: "session_compact" }); }, [sendCommandAction]);
  const setComposerModel = useCallback((model: WireModel) => { sendCommandAction({ action: "model_set", provider: model.provider, modelId: model.id }); }, [sendCommandAction]);
  const setComposerThinking = useCallback((level: ThinkingLevel) => { sendCommandAction({ action: "thinking_set", level }); }, [sendCommandAction]);
  const startupLoadingVisible = useDelayedVisibility(startupState === "loading");
  const canAttach = !newSessionPending && connection === "online" && attachments.snapshot.capability.status === "supported" && !attachments.snapshot.active;
  // 本地工作区通常很快打开：300ms 内完成不显示加载屏，只留与启动图同色的底，避免启动后闪一下；出现后至少保留 500ms。
  if (startupState === "loading" || (startupState === "ready" && startupLoadingVisible)) return <StartupLoading visible={startupLoadingVisible} />;
  if (startupState === "error") return <StartupErrorView error={startupError} onRetry={() => window.location.reload()} />;
  const openLatestHistory = historySessions[0] ? () => selectHistory(historySessions[0]!) : undefined;
  const navigation: WorkspaceNavigationProps = { devices, endpoints, history: navigationHistory, historyListStatus, onRetryHistory: () => { void refreshHistory(); }, activeDeviceId, activeEndpointId, selectedHistoryId: selectedHistory?.id ?? null, snapshotReady, pairingPresence, deviceActivity, completedEndpointIds, onPair: openPairing, onSettings: () => openSettings({ kind: "workspace" }), onSelectDevice: (deviceId) => { if (deviceId !== activeDeviceId) switchOut.run(() => navigate(() => selectDevice(deviceId))); else switchOut.settle(); }, onSelectEndpoint: selectLiveEndpoint, onSelectHistory: selectHistory, onSwitchIntent: (target) => { if (switchesTo(target)) switchOut.begin(); }, onRename: (device) => { setRenameFocusOrigin(focusedElement()); setRenameDevice(device); }, onRemove: (device) => requestConfirmation({ kind: "remove-pairing", label: displayDevice(device), device }) };
  const computerName = activeDevice ? displayDevice(activeDevice) : t.navigation.fallbackLabel;
  const awaitingSession = activeDevice !== null && (placeholderKind === "checking" || placeholderKind === "opening");
  const historyEndpoint = selectedHistory ? endpoints.find((endpoint) => endpoint.deviceId === selectedHistory.deviceId && endpoint.endpointId === selectedHistory.endpointId) ?? null : null;
  const titleBar: PwaWorkspaceTitleBar = {
    ...(selectedHistory
      ? { title: historySessionTitle(selectedHistory), prefix: cwdName(historyEndpoint?.cwd), showTitle: true, moreMenu: <SessionActionsMenu info={{ name: historySessionTitle(selectedHistory), cwd: historyEndpoint?.cwd ?? null, computer: computerName, status: t.common.readOnly }} /> }
      : activeDevice && displayEndpoint
        ? { title: displayPi(displayEndpoint), prefix: cwdName(displayEndpoint.cwd), showTitle: true, moreMenu: <SessionActionsMenu info={{ name: displayPi(displayEndpoint), cwd: displayEndpoint.cwd ?? null, computer: computerName, status: exitedDisplay ? t.workspace.exited : displayEndpoint.working ? t.actions.running : t.actions.idle }} /> }
        // 没有配对或未选中电脑时，移动顶栏显示品牌名（不翻译），不把「导航」当标题。
        // 等待在线 Pi 与打开会话期间标题留空：会话名与输入区随后一起出现，不先闪过电脑名。
        : { title: activeDevice ? (awaitingSession ? "" : computerName) : "Pi Reach", showTitle: false }),
    navigationNotice: completedEndpointIds.size > 0,
  };
  const connectionHintView = connectionHint(connectionIssue, connectionStage, displayConnection === "connecting" || displayConnection === "retrying", {
    reconnecting: t.connection.reconnectingHint, relayAutoRetrying: t.connection.relayAutoRetrying, unavailable: t.connection.unavailable, networkWaiting: t.connection.networkWaiting,
  });
  const recoveryFailed = catchupFailed && !catchingUp;
  const composerRecoveryHint: OperationHint | null = liveSessionShown && connection === "online" && !sendReady
    ? { text: recoveryFailed ? t.composer.historyRecoveryFailed : t.composer.historyRecovering, tone: recoveryFailed ? "neutral" : "running", busy: !recoveryFailed }
    : null;
  const retryDisabled = retryPending || displayConnection === "connecting";
  const composerConnectionHint: OperationHint | null = connectionHintView ? {
    text: connectionHintView.text, tone: "neutral", busy: connectionHintView.busy,
    action: connectionHintView.retry ? { label: t.connection.retryNow, onAction: retryCurrentSession, disabled: retryDisabled } : undefined,
  } : null;
  // 新会话无消息时显示目录 · 模型 · 思考级别，发送前就能确认对象；缺哪项省略哪项。
  const emptySessionContext = displayEndpoint
    ? [cwdName(displayEndpoint.cwd), currentModel?.name ?? displayEndpoint.model ?? null, displayEndpoint.thinking ? t.commands.thinkingLevelValue(activeThinking) : null].filter(Boolean).join(" · ") || null
    : null;
  // 时间线展示状态（展开选择、阅读器选择）只属于同一真实会话；会话尚未确认属于当前 Pi 时不沿用旧来源。
  const liveSourceKey = liveSession && displayEndpoint && liveSession.deviceId === displayEndpoint.deviceId && liveSession.endpointId === displayEndpoint.endpointId
    ? JSON.stringify(["live", liveSession.deviceId, liveSession.endpointId, liveSession.sessionId]) : undefined;
  const liveTimeline = <MessageList sourceKey={liveSourceKey} items={visibleTimelineItems.filter((item) => !isQueuedMessage(item))} hasEarlier={!newSessionPending && hasEarlier} loadingEarlier={!newSessionPending && loadingEarlier} onLoadEarlier={loadEarlier} loadEarlierFailed={loadEarlierFailed} autoLoadEarlier={!followingOutput} listRef={messageListRef} bottomSentinelRef={bottomSentinelRef} onScroll={handleScroll} isLive={connection === "online" && !newSessionPending} fileSourceCurrent={!newSessionPending} emptyContext={emptySessionContext} running={!newSessionPending && (displayEndpoint?.working === true || timelineDisplayPending)} compacting={compactingNow} notices={compactionNotices} onReadingChange={onToolReading} reconnectPhase={newSessionPending ? null : reconnectPhase} loading={!newSessionPending && (sessionLoading || sessionSkeletonVisible)} skeletonVisible={!newSessionPending && sessionSkeletonVisible} topNotice={!newSessionPending && sessionSwitched ? t.workspace.sessionSwitched : null} onRetryFailed={retryFailed} onCheckStatus={checkDeliveryStatus} />;
  const mainContent = selectedHistory
    ? <HistoryConversation sourceKey={JSON.stringify(["history", selectedHistory.id])} onReadingChange={onToolReading} items={timelineItems} savedEvents={timelineHistory?.events ?? NO_EVENTS} hasEarlier={hasEarlier} loadingEarlier={loadingEarlier} loadEarlierFailed={loadEarlierFailed} onLoadEarlier={loadEarlierTimeline} loading={timelineHistory?.status === "loading"} viewport={{ messageListRef, bottomSentinelRef, handleScroll, followingOutput, latestEntryVisible, showLatest }} modelName={selectedHistory.model ?? null} thinking={safeThinkingLevel(selectedHistory.thinking)} />
    : activeDevice && displayEndpoint
      ? <TimelineWorkspace timeline={liveTimeline} footer={<>{exitedDisplay ? <ReadOnlyComposer notice={t.workspace.exitedNote} modelName={currentModel?.name ?? displayEndpoint.model ?? null} thinking={activeThinking} /> : <><PwaMessageActions show={recoveryFailed || latestEntryVisible} showRetry={recoveryFailed} showLatest={latestEntryVisible} unreadOutput={unreadOutput} onRetry={() => { void retryCatchup(); }} onLatest={showLatest} /><MessageComposer queuedMessages={<QueuedMessagesPanel items={visibleTimelineItems} onCommit={reportQueueCommit} isOnline={connection === "online" && !newSessionPending} isWorking={displayEndpoint.working === true} runtimeRef={timelineRuntimeRef} channelRef={channelRef} applyChange={applyTimelineChange} onError={setError} />} attachments={attachments.items} canAttach={canAttach} sendingAttachments={attachments.snapshot.active} attachmentNotice={attachments.notice} operationHint={operationNotice ?? composerRecoveryHint} connectionHint={composerConnectionHint} sendReady={sendReady} isOnline={connection === "online"} isWorking={displayEndpoint.working === true} stopping={stopRequest !== null} draft={draft} onDraftChange={changeComposerDraft} onSend={sendMessage} onStop={stopCurrentTask} onAddFiles={attachments.addFiles} onRemoveAttachment={attachments.remove} onRetryAttachment={attachments.retry} commandModels={models} commandModelsStatus={modelsStatus} commandCurrentModel={currentModel} commandCurrentModelFallback={displayEndpoint.model ?? null} commandThinking={activeThinking} commandPendingAction={pendingAction?.action ?? null} onNewSession={requestNewSession} onCompactSession={compactCurrentSession} onSetModel={setComposerModel} onSetThinking={setComposerThinking} onCommandsOpen={requestModels} /></>}</>} />
      : devices.length > 0 && connectionIssue !== null && connectionStage !== null
        ? <ConnectionIssueWorkspace kind={connectionIssue} stage={connectionStage} busy={connectionHintView?.busy ?? false} onRetry={retryCurrentSession} retryDisabled={retryDisabled} />
        : skeletonVisible || mainLoading
        ? <WorkspaceSkeleton visible={skeletonVisible} />
        : devices.length === 0
          ? <UnpairedWorkspace onPair={openPairing} />
          : placeholderKind === "choose-computer"
            ? <ChooseComputerWorkspace />
            : placeholderKind === "choose-pi"
              ? <ChoosePiWorkspace endpoints={onlinePis} completedEndpointIds={completedEndpointIds} onSelect={openLiveEndpoint} />
              : <NoPiWorkspace onViewHistory={openLatestHistory} />;
  const toolDetailsScope = identity && (selectedHistory ?? liveSession) ? { ownerId: toStoredKey(identity.publicKey), deviceId: (selectedHistory ?? liveSession)!.deviceId, endpointId: (selectedHistory ?? liveSession)!.endpointId, sessionId: (selectedHistory ?? liveSession)!.sessionId } : null;
  return <ToolDetailsProvider value={{ controller: toolDetailsController, scope: toolDetailsScope, sourceKey: selectedHistory ? JSON.stringify(["history", selectedHistory.id]) : liveSourceKey, online: selectedHistory === null && connection === "online" && !newSessionPending && toolDetailsSupported, connection: () => {
    const scope = timelineRuntimeRef.current.currentScope;
    const channel = channelRef.current;
    if (selectedHistoryRef.current !== null || connectionRef.current !== "online" || !toolDetailsSupportedRef.current || !scope || !channel || channel.closed || timelineRuntimeRef.current.replacing || channel.channelId !== scope.channelId) return null;
    return { channelId: scope.channelId, sessionId: scope.sessionId, leafId: scope.leafId, runtimeInstanceId: scope.runtimeInstanceId, send: frame => channel.send(frame) };
  } }}><PublishedFilesProvider value={fileView}><PwaWorkspaceLayout navigation={navigation} titleBar={titleBar} connectionState={displayConnection} toast={<PwaStatusError message={selectedHistory ? historyError : error ?? recoveryError} onDismiss={() => { if (selectedHistory) setHistoryError(null); else if (error !== null) setError(null); else setRecoveryError(null); }} />} operationNotifications={standalone ? <PwaOperationNotifications controller={operationNotifications} /> : null} settingsRoute={settingsRoute} onOpenSettings={openSettings} onSettingsBack={closeSettings} renderSettings={({ backLabel, titleRef, onShowShortcuts }) => <SettingsPage viewportDiagnostics viewportDiagnosticsOnline={sessionOnline && selectedHistory === null} onShowShortcuts={onShowShortcuts} relayUrl={relayUrl} defaultRelayUrl={defaultRelayUrl} relayVersion={relayVersion} relayStatus={relayStatus} extensionVersion={extensionVersion} extensionStatus={connection} extensionTarget={sessionOnline && activeDevice && activeEndpoint ? `${displayDevice(activeDevice)} · ${displayPi(activeEndpoint)}` : null} onSave={saveRelayUrl} onBack={closeSettings} backLabel={backLabel} titleRef={titleRef} onClearData={() => requestConfirmation({ kind: "clear-local-data" })} onResetLayout={() => resetOutputFollowing()} />} overlays={<>{renameDevice ? <RenamePairingDialog device={renameDevice} onSave={(nickname) => saveDeviceNickname(renameDevice, nickname)} onClose={() => setRenameDevice(null)} focusOrigin={renameFocusOrigin} focusFallbackSelectors={[".pwa-session-sheet .pwa-navigation-close", ".pwa-session-trigger"]} /> : null}
    <PairingDialog opened={pairing.state !== "idle"} connecting={pairing.state === "pairing"} error={pairing.error} onSubmit={(code) => { void pairing.pairFromCode(code); }} onClearError={pairing.clearError} onClose={pairing.close} focusOrigin={pairingFocusOrigin} focusFallbackSelectors={[".pwa-session-trigger"]} />
    <ConfirmActionDialog action={confirmAction?.kind === "remove-pairing" ? { kind: "remove-pairing", label: confirmAction.label } : confirmAction} fetchingFiles={fileView.active && (confirmAction?.kind !== "remove-pairing" || isActiveDevice(confirmAction.device.id))} pending={confirmPending} error={confirmError} onConfirm={() => { void confirmRequestedAction(); }} onClose={() => { if (!confirmPendingRef.current) { setConfirmAction(null); setConfirmError(null); } }} onExitTransitionEnd={finishConfirmationTransition} /></>} closeBackgroundOverlay={closeBackgroundOverlay}>{mainContent}</PwaWorkspaceLayout></PublishedFilesProvider></ToolDetailsProvider>;
}
