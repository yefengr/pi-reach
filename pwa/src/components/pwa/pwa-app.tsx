import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@mantine/core";
import { MessageComposer } from "@/components/pwa/message-composer";
import { RenamePairingDialog } from "@/components/pwa/rename-pairing-dialog";
import { ConfirmActionDialog } from "@/components/pwa/confirm-action-dialog";
import { COMPOSER_THINKING_LEVELS, type ComposerCommandAction } from "@/components/pwa/composer-command-menu";
import { MessageList } from "@/components/pwa/message-list";
import { PublishedFilesProvider } from "./published-files-context";
import { useSessionFiles } from "./use-session-files";
import { isQueuedMessage, QueuedMessagesPanel } from "@/components/pwa/queued-messages-panel";
import { decodeBase64 } from "@/lib/pi-reach/encoding";
import { describeStartupFailure, StartupErrorView, StartupLoading, type StartupError } from "@/components/pwa/pwa-startup";
import { PairingDialog } from "@/components/pwa/pairing-dialog";
import { connectionBannerTiming, PwaConnectionBanner, PwaMessageActions, PwaStatusToast, type PwaConnectionBannerKind } from "@/components/pwa/pwa-app-actions";
import { focusedElement, runConfirmAction, useConfirmationOverlay, type ConfirmActionRequest } from "@/components/pwa/pwa-confirm-actions";
import { SettingsPage } from "@/components/pwa/settings-page";
import { reloadWorkspace, useSettingsRoute } from "@/lib/pwa/settings-route";
import { SessionActionsMenu } from "@/components/pwa/session-actions-menu";
import { ConnectionStatus, cwdName, displayDevice, type ConnectionViewState, type WorkspaceNavigationProps } from "@/components/pwa/workspace-view";
import { displayPi } from "@/components/pwa/session-title";
import { PwaWorkspaceLayout } from "@/components/pwa/pwa-workspace-layout";
import { PwaOperationNotifications, PwaToastProvider, useToast } from "@/components/pwa/pwa-operation-notifications";
import { ChooseComputerWorkspace, ChoosePiWorkspace, HistoryWorkspace, LiveWorkspace, NoPiWorkspace, UnpairedWorkspace, useDelayedVisibility, WorkspaceSkeleton } from "@/components/pwa/workspace-content";
import type { WorkspaceTitleBarProps } from "@/components/pwa/workspace-title-bar";
import { PeerChannel } from "@/lib/pi-reach/peer-channel";
import { generateOwnerKeyPair } from "@/lib/pi-reach/crypto";
import { assertBrowserCapabilities, fromStoredKey, migrateLegacyDefaultRelay, toStoredKey, type ConnectionContext } from "@/lib/pwa/runtime";
import { derivePairingPresence } from "@/lib/pwa/pwa-view-model";
import { readDefaultRelayUrl } from "@/lib/pwa/runtime-config";
import { useEndpointRegistry } from "@/lib/pwa/use-endpoint-registry";
import { useDevicePairing, type DevicePairingResult } from "@/lib/pwa/use-device-pairing";
import { ACTIVE_DEVICE_SETTING, activeEndpointSettingKey, useActiveEndpointSelection } from "@/lib/pwa/use-active-endpoint-selection";
import { PendingCapacityError, type QueuedCancellation, type TimelineScope, type TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import type { TimelineSessionPosition } from "@/lib/pwa/use-timeline-viewport";
import { useLiveTimeline } from "@/lib/pwa/use-live-timeline";
import { useHistorySessionList } from "@/lib/pwa/use-history-session-list";
import { useHistorySessionNames } from "@/lib/pwa/use-history-session-names";
import { historySessionTitle } from "@/lib/pwa/history-preview";
import { useRelayConnection } from "@/lib/pwa/use-relay-connection";
import { attachmentTargetKey } from "@/lib/pwa/attachment-composer";
import { useAttachmentComposer } from "@/lib/pwa/use-attachment-composer";
import { loadTimeline, type TimelineSessionSummary } from "@/lib/pwa/timeline-store";
import { receiveTimelineFrame } from "@/lib/pwa/timeline-frame-handler";
import { ReconnectState } from "@/lib/pwa/reconnect-state";
import { actionErrorFeedback, actionSendFailureFeedback, createOperationNotificationController } from "@/lib/pwa/operation-notifications";
import { safeFeedbackMessage, type FeedbackSource } from "@/lib/pwa/feedback-messages";
import { recoverServerFrame } from "@/lib/pwa/server-frame-recovery";
import type { ControlFrame, OwnerKeyPair, ThinkingLevel, WireModel } from "@/lib/pi-reach/types";
import type { ClientFrame, ServerFrame } from "@/lib/pi-reach/protocol-v2/frames";
import { getMessages, useI18n } from "@/lib/i18n";
import {
  clearPwaData,
  getPwaDatabase,
  listPwaDevices,
  openPwaDatabase,
  removePwaDeviceData,
  type PwaDeviceRecord,
} from "@/lib/pwa/db";

const LEGACY_DEFAULT_RELAYS = ["https://relay-pi.yefengr.cn"];

const RELAY_SETTING = "relay_url";
type StartupState = "loading" | "ready" | "error";
type ComposerCommandRequest =
  | { action: "session_new" | "session_compact" }
  | { action: "model_set"; provider: string; modelId: string }
  | { action: "thinking_set"; level: ThinkingLevel };
type PendingAction = { id: string; action: ComposerCommandAction; previousVisionAvailable?: boolean | null };
type WorkspacePlaceholderKind = "choose-computer" | "checking" | "choose-pi" | "no-pi" | "opening";
type PwaWorkspaceTitleBar = Omit<WorkspaceTitleBarProps, "onOpenNavigation" | "navigationExpanded">;
function id(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function safeThinkingLevel(value: unknown): ThinkingLevel { return typeof value === "string" && COMPOSER_THINKING_LEVELS.includes(value as ThinkingLevel) ? value as ThinkingLevel : "off"; }
function resolveEndpointModel(models: readonly WireModel[], endpointModel: string | undefined): WireModel | undefined {
  if (!endpointModel) return undefined;
  const matches = models.filter((model) => model.id === endpointModel || model.name === endpointModel);
  return matches.length === 1 ? matches[0] : undefined;
}
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
  const [identity, setIdentity] = useState<OwnerKeyPair | null>(null); const [devices, setDevices] = useState<PwaDeviceRecord[]>([]);
  const [connection, setConnection] = useState<ConnectionViewState>("offline");
  const [extensionVersion, setExtensionVersion] = useState<string | null>(null);
  const [connectionFeedback, setConnectionFeedback] = useState<PwaConnectionBannerKind | null>(null);
  const [sessionRestartToken, setSessionRestartToken] = useState(0);
  const [defaultRelayUrl, setDefaultRelayUrl] = useState("");
  const [relayUrl, setRelayUrl] = useState(""); const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const setDraftFor = useCallback((key: string, value: string) => setDrafts((current) => current[key] === value ? current : { ...current, [key]: value }), []);
  const [draftSessions, setDraftSessions] = useState<Readonly<Record<string, string>>>({});
  // 当前查看的 Pi 退出后保留会话原位显示，并暂停自动选择，直到用户选择其他 Pi 或离开。
  const [exitedEndpoint, setExitedEndpoint] = useState<import("@/lib/pwa/db").PwaEndpointRecord | null>(null);
  const [sessionSwitched, setSessionSwitched] = useState(false);
  const [visionAvailable, setVisionAvailable] = useState<boolean | null>(null); const [models, setModels] = useState<WireModel[]>([]);
  const [currentModel, setCurrentModel] = useState<WireModel | null>(null); const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [stopRequestId, setStopRequestId] = useState<string | null>(null);
  const { route: settingsRoute, openSettings, closeSettings } = useSettingsRoute();
  const [renameDevice, setRenameDevice] = useState<PwaDeviceRecord | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmActionRequest | null>(null); const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const [startupState, setStartupState] = useState<StartupState>("loading"); const [startupError, setStartupError] = useState<StartupError | null>(null);
  const [selectedHistory, setSelectedHistory] = useState<TimelineSessionSummary | null>(null);
  const [historyItems, setHistoryItems] = useState<TimelineViewItem[]>([]); const [historyError, setHistoryError] = useState<string | null>(null);
  const [renameFocusOrigin, setRenameFocusOrigin] = useState<HTMLElement | null>(null);
  const [pairingFocusOrigin, setPairingFocusOrigin] = useState<HTMLElement | null>(null);
  const [liveEndpointSnapshot, setLiveEndpointSnapshot] = useState<import("@/lib/pwa/db").PwaEndpointRecord | null>(null);
  const [retryPending, setRetryPending] = useState(false);
  const [retainLiveSnapshot, setRetainLiveSnapshot] = useState(false);
  // 最近一次握手成功的实时会话，用于在本地历史中隐藏仍在线的同一会话。
  const [liveSession, setLiveSession] = useState<{ deviceId: string; endpointId: string; sessionId: string } | null>(null);

  const reportHistoryFailure = useCallback((message: string) => setError(safeFeedbackMessage(message, "history")), []);
  const reportSessionFailure = useCallback((message: string, source: FeedbackSource) => setError(safeFeedbackMessage(message, source)), []);
  const reportProtocolFailure = useCallback((message: string) => setError(safeFeedbackMessage(message, "protocol")), []);
  const channelRef = useRef<PeerChannel | null>(null); const draftVersionRef = useRef(0); const draftKeyRef = useRef("");
  const connectionGenerationRef = useRef(0); const connectionRef = useRef(connection); const selectedHistoryRef = useRef<TimelineSessionSummary | null>(selectedHistory);
  useLayoutEffect(() => { connectionRef.current = connection; selectedHistoryRef.current = selectedHistory; }, [connection, selectedHistory]);
  const retryPendingRef = useRef(false); const retryDeviceIdRef = useRef<string | null>(null); const retryEndpointIdRef = useRef<string | null>(null);
  const sessionChannelIdRef = useRef(id()); const sessionRecoveryStateRef = useRef(new ReconnectState());
  const sessionIdentityRef = useRef<string | null>(null);
  const relaySelectionRef = useRef<{ deviceId: string | null; endpointId: string | null }>({ deviceId: null, endpointId: null });
  const channelContextRef = useRef<ConnectionContext | null>(null);
  const helloRequestRef = useRef<string | null>(null);
  const modelRequestRef = useRef<string | null>(null);
  const extensionInfoRequestRef = useRef<string | null>(null);
  const activeEndpointModelRef = useRef<string | undefined>(undefined);
  const confirmPendingRef = useRef(false);
  const pendingActionRef = useRef<PendingAction | null>(null);
  const stopRequestIdRef = useRef<string | null>(null);
  const historyLoadTokenRef = useRef(0);
  const lastSessionByRuntimeRef = useRef(new Map<string, string>());
  const lastFocusedSessionRef = useRef<string | null>(null);
  const emptySessionFocusRef = useRef<string | null>(null);
  // 由运行时确认的排队消息撤回，交给当前输入区回填；帧处理回调经 ref 取最新的草稿与附件。
  const restoreQueuedRef = useRef<(cancellations: readonly QueuedCancellation[]) => void>(() => undefined);
  const {
    items: timelineItems,
    setLastSyncedAt,
    hasEarlier,
    loadingEarlier,
    reconnectPhase,
    catchupFailed,
    catchingUp,
    followingOutput,
    unreadOutput,
    messageListRef,
    bottomSentinelRef,
    receiveRealtimeOutput,
    handleScroll,
    showLatest,
    reset: resetOutputFollowing,
    captureSessionPosition,
    restoreSessionPosition,
    setReadingDetails,
    runtimeRef: timelineRuntimeRef,
    historyLoaderRef,
    fragmentAssemblerRef,
    applyTimelineChange,
    startLive,
    retryCatchup,
    loadEarlier: loadEarlierTimeline,
    disconnect: disconnectTimeline,
    invalidateScope: invalidateTimelineScope,
    clearTimeline,
  } = useLiveTimeline({
    channelRef,
    enabled: selectedHistory === null,
    reportHistoryFailure,
  });

  const attachments = useAttachmentComposer((message) => {
    const scope = timelineRuntimeRef.current.currentScope;
    const channel = channelRef.current;
    if (!scope || !channel || channel.closed || connectionRef.current !== "online" || selectedHistoryRef.current !== null ||
        attachmentTargetKey(scope) !== message.target || draftKeyRef.current !== message.context.draftKey) return false;
    try {
      const requestIds = { clientRequestId: message.clientRequestId, requestId: id() };
      const prepared = message.attachments.length
        ? timelineRuntimeRef.current.sendUserWithAttachments(message.text, message.attachments, requestIds)
        : timelineRuntimeRef.current.sendUser(message.text, undefined, requestIds);
      if (!prepared) return false;
      applyTimelineChange(prepared.change);
      if (!channel.send(prepared.frame)) {
        applyTimelineChange(timelineRuntimeRef.current.markUnknownDelivery(prepared.frame.client_request_id));
        setError("Message could not be sent. Check the connection and try again.");
      }
      if (draftVersionRef.current === message.context.draftVersion && draftKeyRef.current === message.context.draftKey) setDraftFor(message.context.draftKey, "");
      return true;
    } catch (sendError) {
      reportSessionFailure(sendError instanceof PendingCapacityError ? sendError.message : "Could not send this message. Try again.", "message-send");
      return false;
    }
  }, t.attachments);
  const attachmentComposer = attachments.composer;
  const addAttachmentFiles = attachments.addFiles;
  const { controller: fileController, readyRef: filesReadyRef, view: fileView, onToolReading } = useSessionFiles({
    ready: connection === "online" && selectedHistory === null && !catchingUp && !catchupFailed && !reconnectPhase,
    items: timelineItems, runtimeRef: timelineRuntimeRef, channelRef, setReading: setReadingDetails,
  });

  const onDeviceSelected = useCallback(() => {
    operationNotifications.clearSession();
    historyLoadTokenRef.current += 1;
    setSelectedHistory(null); setHistoryItems([]); setHistoryError(null);
    setLiveEndpointSnapshot(null);
    setExitedEndpoint(null);
    setSessionSwitched(false);
    clearTimeline();
    setError(null);
  }, [clearTimeline, operationNotifications]);
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
  const currentViewKey = selectedHistory ? `history:${selectedHistory.id}` : displayEndpoint ? `live:${endpointDraftKey}` : null;
  useLayoutEffect(() => { currentViewKeyRef.current = currentViewKey; }, [currentViewKey]);
  const draft = drafts[draftKey] ?? "";
  const activeThinking = useMemo(() => safeThinkingLevel(displayEndpoint?.thinking), [displayEndpoint?.thinking]);
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
    fileController.disconnect();
    filesReadyRef.current = false;
    connectionGenerationRef.current += 1;
    channelRef.current?.close();
    channelRef.current = null;
    channelContextRef.current = null;
    helloRequestRef.current = null;
    modelRequestRef.current = null;
    extensionInfoRequestRef.current = null;
    pendingActionRef.current = null;
    stopRequestIdRef.current = null;
    setPendingAction(null);
    setStopRequestId(null);
    setVisionAvailable(null);
    setModels([]);
    setCurrentModel(null);
    setExtensionVersion(null);
    disconnectTimeline();
    attachmentComposer.disconnect();
  }, [attachmentComposer, disconnectTimeline, fileController, filesReadyRef]);
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
    retryAttempt,
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
  const { historySessions, refreshHistory } = useHistorySessionList({
    deviceId: activeDevice?.deviceId ?? null,
    onError: reportHistoryFailure,
    onSessionsLoaded: useCallback((sessions) => {
      setSelectedHistory((current) => current ? sessions.find((session) => session.id === current.id) ?? current : null);
    }, []),
  });
  const { rememberSessionName, invalidateSessionNames } = useHistorySessionNames({ endpoint: activeEndpoint, runtimeRef: timelineRuntimeRef, channelRef, helloRequestRef, onSaved: refreshHistory, onError: reportHistoryFailure, replacingSession: pendingAction?.action === "session_new" });
  // 同一次访问中切回看过的会话时恢复离开时的阅读位置；只保存在页面内存中。首次打开停在底部最新内容。
  const sessionPositionsRef = useRef(new Map<string, TimelineSessionPosition | { history: true; scrollTop: number; atBottom: boolean }>());
  const currentViewKeyRef = useRef<string | null>(null);
  const [historyRestoreScrollTop, setHistoryRestoreScrollTop] = useState<number | null>(null);
  const rememberSessionPosition = useCallback(() => {
    const key = currentViewKeyRef.current;
    if (!key) return;
    if (key.startsWith("history:")) {
      const list = messageListRef.current;
      if (list) sessionPositionsRef.current.set(key, { history: true, scrollTop: list.scrollTop, atBottom: list.scrollHeight - list.scrollTop - list.clientHeight <= 1 });
      return;
    }
    const position = captureSessionPosition();
    if (position) sessionPositionsRef.current.set(key, position);
  }, [captureSessionPosition, messageListRef]);
  const openHistory = useCallback((history: TimelineSessionSummary) => {
    operationNotifications.clearSession();
    rememberSessionPosition();
    const saved = sessionPositionsRef.current.get(`history:${history.id}`);
    setHistoryRestoreScrollTop(saved && "history" in saved && !saved.atBottom ? saved.scrollTop : null);
    const token = ++historyLoadTokenRef.current;
    setExitedEndpoint(null);
    setSessionSwitched(false);
    setSelectedHistory(history);
    setHistoryItems([]);
    setHistoryError(null);
    resetOutputFollowing();
    clearSessionConnection();
    void loadTimeline(history)
      .then((events) => { if (token === historyLoadTokenRef.current) setHistoryItems(events.map((event) => ({ kind: "event", event }))); })
      .catch(() => { if (token === historyLoadTokenRef.current) setHistoryError("Could not read the saved conversation."); });
  }, [clearSessionConnection, operationNotifications, rememberSessionPosition, resetOutputFollowing]);
  const openLiveEndpoint = useCallback((endpointId: string) => {
    if (selectedHistory !== null || activeEndpointId !== endpointId) setExtensionVersion(null);
    operationNotifications.clearSession();
    historyLoadTokenRef.current += 1;
    setSelectedHistory(null); setHistoryItems([]); setHistoryError(null);
    if (liveEndpointSnapshot?.endpointId !== endpointId) { setLiveEndpointSnapshot(null); setSessionSwitched(false); }
    setExitedEndpoint(null);
    rememberSessionPosition();
    resetOutputFollowing();
    const saved = activeDevice ? sessionPositionsRef.current.get(`live:${activeDevice.deviceId}\u0000${endpointId}`) : undefined;
    restoreSessionPosition(saved && !("history" in saved) ? saved : null);
    selectEndpoint(endpointId);
  }, [activeDevice, activeEndpointId, liveEndpointSnapshot?.endpointId, operationNotifications, rememberSessionPosition, resetOutputFollowing, restoreSessionPosition, selectEndpoint, selectedHistory]);
  const sendModelsRequest = useCallback((scope: TimelineScope, channel: PeerChannel): boolean => {
    const requestId = id();
    modelRequestRef.current = requestId;
    if (channel.send({ protocol_version: 2, type: "list_models", id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId })) return true;
    if (modelRequestRef.current === requestId) modelRequestRef.current = null;
    return false;
  }, []);

  const sendExtensionInfoRequest = useCallback((scope: TimelineScope, channel: PeerChannel) => {
    const requestId = id();
    extensionInfoRequestRef.current = requestId;
    if (channel.send({ protocol_version: 2, type: "extension_info_request", id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId })) return;
    if (extensionInfoRequestRef.current === requestId) extensionInfoRequestRef.current = null;
  }, []);

  const handleServerFrame = useCallback((frame: ServerFrame, context: ConnectionContext) => {
    const current = channelContextRef.current;
    if (!current || current.generation !== context.generation || current.deviceId !== context.deviceId || current.endpointId !== context.endpointId || current.runtimeInstanceId !== context.runtimeInstanceId || channelRef.current !== context.channel || relayRef.current !== context.relay) return;
    if (fileController.receive(frame)) return;
    if (attachmentComposer.receive(frame)) return;
    if (frame.type === "reset" || frame.type === "bye") {
      const scope = timelineRuntimeRef.current.currentScope;
      if (!scope || scope.sessionId !== frame.session_id) return;
      if (frame.type === "bye" && scope.leafId !== frame.leaf_id) return;
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
      const scope: TimelineScope = { deviceId: context.deviceId, endpointId: context.endpointId, runtimeInstanceId: context.runtimeInstanceId, sessionId: frame.session_id, leafId: frame.leaf_id, selfSenderRef: frame.self_sender_ref, channelId: context.channel.channelId };
      // 同一 Pi 进程换了会话（如执行 /new）：主区跟随新会话，并在开头标出切换。
      const runtimeKey = `${context.deviceId}\u0000${context.endpointId}\u0000${context.runtimeInstanceId}`;
      const previousSession = lastSessionByRuntimeRef.current.get(runtimeKey);
      lastSessionByRuntimeRef.current.set(runtimeKey, frame.session_id);
      setDraftSessions((current) => current[runtimeKey] === frame.session_id ? current : { ...current, [runtimeKey]: frame.session_id });
      if (previousSession !== undefined && previousSession !== frame.session_id) setSessionSwitched(true);
      emptySessionFocusRef.current = frame.head_seq === 0 ? `${context.deviceId}\u0000${context.endpointId}\u0000${frame.session_id}` : null;
      startLive({ scope, headSeq: frame.head_seq, send: (request) => context.channel.send(request), onHistoryChanged: () => { void refreshHistory(); } });
      // 握手即已在线；上传状态回执可能先于 React commit 到达，不能读上一帧的 connecting。
      connectionRef.current = "online";
      attachmentComposer.connect(scope, (request) => context.channel.send(request));
      setLiveSession({ deviceId: context.deviceId, endpointId: context.endpointId, sessionId: frame.session_id });
      rememberSessionName(scope);
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
      modelRequestRef.current = null;
      const currentModelFromEndpoint = frame.current ?? resolveEndpointModel(frame.models, activeEndpointModelRef.current);
      setModels(frame.models); setCurrentModel(currentModelFromEndpoint ?? null); setVisionAvailable(currentModelFromEndpoint?.vision ?? null); return;
    }
    if (frame.type === "action_ok" || frame.type === "action_error") {
      const pending = pendingActionRef.current;
      if (pending?.id !== frame.in_reply_to) return;
      pendingActionRef.current = null; setPendingAction(null);
      if (frame.type === "action_error") {
        if (pending.action === "model_set") setVisionAvailable(pending.previousVisionAvailable ?? null);
        operationNotifications.show(actionErrorFeedback(pending.action));
        return;
      }
      operationNotifications.clearAction(pending.action);
      if (pending.action === "model_set") {
        const scope = timelineRuntimeRef.current.currentScope;
        if (scope) sendModelsRequest(scope, context.channel);
      }
      return;
    }
    if (frame.type === "cancelled") {
      if (frame.in_reply_to !== stopRequestIdRef.current) return;
      stopRequestIdRef.current = null; setStopRequestId(null); operationNotifications.clearStop(); return;
    }
    if (historyLoaderRef.current?.receive(frame)) return;
    receiveTimelineFrame(frame, {
      runtime: timelineRuntimeRef.current, fragmentAssemblerRef, isCurrent: () => channelRef.current === context.channel,
      applyTimelineChange: (change, reset) => {
        applyTimelineChange(change, reset);
        const scope = timelineRuntimeRef.current.currentScope;
        if (scope) attachmentComposer.connect(scope, (request) => context.channel.send(request));
        if (change.cancelledQueued?.length) restoreQueuedRef.current(change.cancelledQueued);
      },
      receiveRealtimeOutput, setError: reportSessionFailure, setLastSyncedAt, onHistoryChanged: refreshHistory,
    });
  }, [attachmentComposer, fileController, filesReadyRef, applyTimelineChange, disconnectSession, finishRetry, fragmentAssemblerRef, historyLoaderRef, invalidateTimelineScope, operationNotifications, receiveRealtimeOutput, refreshHistory, relayRef, rememberSessionName, reportSessionFailure, restartSession, sendExtensionInfoRequest, sendModelsRequest, setLastSyncedAt, startLive, timelineRuntimeRef]);

  useEffect(() => {
    const model = activeEndpoint?.model;
    if (activeEndpointModelRef.current === model) return;
    activeEndpointModelRef.current = model;
    // 会话尚未就绪时，session_ready 的首个请求会读取当前模型。
    if (connection !== "online") return;
    const scope = timelineRuntimeRef.current.currentScope;
    const channel = channelRef.current;
    if (!scope || !channel) return;
    sendModelsRequest(scope, channel);
  }, [activeEndpoint?.model, connection, sendModelsRequest, timelineRuntimeRef]);

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
      fileController.disconnect();
      filesReadyRef.current = false;
      channel?.close();
      disconnectTimeline();
      attachmentComposer.disconnect();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [attachmentComposer, fileController, filesReadyRef, clearSessionConnection, closeRelayIntentionally, disconnectTimeline, handleServerFrame, identity, onlineRef, operationNotifications, relayConnectionGeneration, relayRef, reportProtocolFailure, sessionDeviceId, sessionEndpointId, sessionOnline, sessionRestartToken, sessionRuntimeInstanceId, startupState]);

  const sendMessage = useCallback(() => {
    const scope = timelineRuntimeRef.current.currentScope; const channel = channelRef.current; const text = draft.trim();
    if ((!text && attachmentComposer.snapshot().items.length === 0) || !scope || !channel || connectionRef.current !== "online" || selectedHistoryRef.current !== null || channel.closed || attachmentComposer.snapshot().active) return;
    setError(null);
    if (attachmentComposer.snapshot().items.length) {
      attachmentComposer.connect(scope, (frame) => channel.send(frame));
      attachmentComposer.start(text, { draftKey, draftVersion: draftVersionRef.current });
      return;
    }
    let prepared;
    try { prepared = timelineRuntimeRef.current.sendUser(text, undefined, { clientRequestId: id(), requestId: id() }); }
    catch (sendError) {
      reportSessionFailure(sendError instanceof PendingCapacityError ? sendError.message : "Could not send this message. Try again.", "message-send");
      return;
    }
    if (!prepared) return;
    if (!channel.send(prepared.frame)) { applyTimelineChange(timelineRuntimeRef.current.markUnknownDelivery(prepared.frame.client_request_id)); setError("Message could not be sent. Check the connection and try again."); return; }
    applyTimelineChange(prepared.change); setDraftFor(draftKey, "");
  }, [applyTimelineChange, attachmentComposer, draft, draftKey, reportSessionFailure, setDraftFor, timelineRuntimeRef]);
  const loadEarlier = useCallback(() => {
    if (connection !== "online" || loadingEarlier) return;
    handleScroll(false);
    loadEarlierTimeline();
  }, [connection, handleScroll, loadEarlierTimeline, loadingEarlier]);
  const stopCurrentTask = useCallback(() => {
    const scope = timelineRuntimeRef.current.currentScope; const channel = channelRef.current;
    if (!scope || !channel || stopRequestIdRef.current) return;
    const requestId = id(); stopRequestIdRef.current = requestId; setStopRequestId(requestId);
    if (!channel.send({ protocol_version: 2, type: "cancel", id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId })) { stopRequestIdRef.current = null; setStopRequestId(null); operationNotifications.show("stop-send-failed"); return; }
  }, [operationNotifications, timelineRuntimeRef]);
  const sendCommandAction = useCallback((request: ComposerCommandRequest): boolean => {
    const scope = timelineRuntimeRef.current.currentScope; const channel = channelRef.current;
    if (!scope || !channel || connection !== "online" || pendingActionRef.current) return false;
    if (request.action === "session_new") setError(null);
    const requestId = id();
    const selectedModel = request.action === "model_set"
      ? models.find((model) => model.provider === request.provider && model.id === request.modelId)
      : null;
    let frame: ClientFrame;
    if (request.action === "session_new" || request.action === "session_compact") frame = { protocol_version: 2, type: request.action, id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId };
    else if (request.action === "model_set") frame = { protocol_version: 2, type: "model_set", id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId, provider: request.provider, model_id: request.modelId };
    else {
      const thinking = request as Extract<ComposerCommandRequest, { action: "thinking_set" }>;
      frame = { protocol_version: 2, type: "thinking_set", id: requestId, channel_id: scope.channelId, session_id: scope.sessionId, leaf_id: scope.leafId, level: thinking.level };
    }
    const pending: PendingAction = { id: requestId, action: request.action, ...(request.action === "model_set" ? { previousVisionAvailable: visionAvailable } : {}) };
    pendingActionRef.current = pending; setPendingAction(pending);
    if (!channel.send(frame)) {
      pendingActionRef.current = null; setPendingAction(null);
      if (request.action !== "session_new") operationNotifications.show(actionSendFailureFeedback(request.action));
      return false;
    }
    if (request.action === "model_set" && selectedModel) setVisionAvailable(selectedModel.vision);
    return true;
  }, [connection, models, operationNotifications, timelineRuntimeRef, visionAvailable]);
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
    await invalidateSessionNames();
    await removePwaDeviceData(device.deviceId, device.id, activeEndpointSettingKey(device.id));
    const remaining = await listPwaDevices(); setDevices(remaining);
    if (isActiveDevice(device.id)) selectDevice(remaining[0]?.id ?? null);
  }, [clearSessionConnection, invalidatePersistence, invalidateSessionNames, isActiveDevice, selectDevice]);
  const clearLocalData = useCallback(async () => {
    await invalidatePersistence();
    await invalidateSessionNames();
    await clearPwaData();
  }, [invalidatePersistence, invalidateSessionNames]);
  const saveDeviceNickname = useCallback(async (device: PwaDeviceRecord, nickname: string) => { await getPwaDatabase().devices.put({ ...device, nickname }); setDevices(await listPwaDevices()); }, []);
  const saveRelayUrl = useCallback(async (value: string) => {
    const normalized = value.trim().replace(/\/$/, "") || defaultRelayUrl;
    const updated = devices.map((device) => ({ ...device, relayUrl: normalized }));
    await Promise.all([getPwaDatabase().settings.put({ key: RELAY_SETTING, value: normalized }), getPwaDatabase().devices.bulkPut(updated)]);
    setRelayUrl(normalized); setDevices(updated);
    operationNotifications.notify(getMessages().settings.saved);
  }, [defaultRelayUrl, devices, operationNotifications]);
  // 撤回的排队消息回到当前输入区：空草稿直接填入，已有草稿换行追加；图片只在输入区没有附件时回填。
  const restoreQueuedMessages = useCallback((cancellations: readonly QueuedCancellation[]) => {
    if (!draftKey) return;
    const restored = cancellations.map((item) => item.text).filter((text) => text.trim()).join("\n");
    if (restored) {
      draftVersionRef.current += 1;
      setDrafts((current) => {
        const existing = current[draftKey] ?? "";
        return { ...current, [draftKey]: existing.trim() ? `${existing}\n${restored}` : restored };
      });
    }
    attachmentComposer.restoreAttachments(cancellations.flatMap((item) => item.attachments ?? []));
    const image = cancellations.find((item) => item.images?.length)?.images?.[0];
    if (!image || attachmentComposer.snapshot().items.length) return;
    try {
      addAttachmentFiles([new File([new Uint8Array(decodeBase64(image.data))], getMessages().composer.imageAttachment, { type: image.mime })]);
    } catch { /* 旧图片不能还原时仍保留文字。 */ }
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
    const uploads = attachmentComposer.snapshot().active;
    const files = fileController.snapshot().active;
    const switchTarget = () => { fileController.reset(); filesReadyRef.current = false; next(); };
    if (uploads || files) requestConfirmation({ kind: "leave-attachments", next: switchTarget, uploads, files });
    else switchTarget();
  };
  const selectLiveEndpoint = (endpointId: string) => {
    if (selectedHistory !== null || endpointId !== activeEndpointId) navigate(() => openLiveEndpoint(endpointId));
  };
  const selectHistory = (history: TimelineSessionSummary) => {
    if (selectedHistory?.id !== history.id) navigate(() => openHistory(history));
  };
  const onlinePis = useMemo(() => activePis.filter((endpoint) => endpoint.online !== false).sort((left, right) => displayPi(left).localeCompare(displayPi(right))), [activePis]);
  const placeholderKind: WorkspacePlaceholderKind = !activeDevice ? "choose-computer" : !snapshotReady ? "checking" : onlinePis.length === 0 ? "no-pi" : onlinePis.length > 1 ? "choose-pi" : "opening";
  // 在线 Pi 的当前会话只出现在「在线 Pi」分组：当前选中的 Pi 只隐藏已握手的实时会话；其他在线 Pi 隐藏它在本浏览器中
  // 最近更新的一条历史，视为它当前的会话。Pi 退出或切换会话后，这些记录照常回到本地历史；正在阅读的历史始终保留。
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
      if (session.endpointId === selectedEndpointId) {
        return !(liveSession?.deviceId === session.deviceId && liveSession.endpointId === session.endpointId && liveSession.sessionId === session.sessionId);
      }
      return latestByEndpoint.get(session.endpointId) !== session;
    });
  }, [historySessions, liveSession, onlinePis, selectedEndpointId, selectedHistory?.id]);
  const sessionLoading = selectedHistory === null && activeDevice !== null && displayEndpoint !== null && timelineItems.length === 0 && connection === "connecting";
  const focusEmptySession = useCallback(() => {
    const scope = timelineRuntimeRef.current.currentScope;
    const sessionKey = scope ? `${scope.deviceId}\u0000${scope.endpointId}\u0000${scope.sessionId}` : null;
    if (!sessionKey || sessionKey === lastFocusedSessionRef.current || connection !== "online" || selectedHistory !== null) return;
    // 弹窗退出后才聚焦新会话；连接／会话变化时仍须重新核对身份和空态。
    if (emptySessionFocusRef.current !== sessionKey || timelineItems.length !== 0 || window.matchMedia("(max-width: 767.98px)").matches) return;
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    const input = document.querySelector<HTMLTextAreaElement>(".pwa-composer-input:not(:disabled)");
    if (!input) return;
    input.focus({ preventScroll: true });
    if (document.activeElement === input) lastFocusedSessionRef.current = sessionKey;
  }, [connection, selectedHistory, timelineItems, timelineRuntimeRef]);
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
  const rawConnectionBannerKind: PwaConnectionBannerKind | null = selectedHistory !== null || exitedDisplay !== null
    ? null
    : displayConnection === "no_network"
      ? "network"
      : displayConnection === "offline" || displayConnection === "retrying" || displayConnection === "connecting" && connectionFeedback
        ? "relay"
        : liveSessionShown ? connectionFeedback : null;
  // 断线超过 10 秒才显示提示条；其间只在会话标题区显示重连状态。
  const connectionBannerDue = useDelayedVisibility(rawConnectionBannerKind !== null, connectionBannerTiming.delayMs, 0);
  // 曾经在线后断线、且提示条出现过时，恢复连接后以 Toast 提示「连接已恢复」；首次连接不提示。
  const connectionBannerShownRef = useRef(false);
  const everOnlineRef = useRef(false);
  const connectionBannerVisible = connectionBannerDue && rawConnectionBannerKind !== null;
  useEffect(() => {
    if (connectionBannerVisible) { if (everOnlineRef.current) connectionBannerShownRef.current = true; return; }
    if (displayConnection === "online") everOnlineRef.current = true;
    if (connectionBannerShownRef.current && displayConnection === "online") {
      connectionBannerShownRef.current = false;
      operationNotifications.notify(getMessages().connection.restored);
    }
  }, [connectionBannerVisible, displayConnection, operationNotifications]);
  const [completedEndpointIds, setCompletedEndpointIds] = useState<ReadonlySet<string>>(() => new Set());
  const previousWorkingRef = useRef(new Map<string, boolean>());
  const viewingEndpointId = selectedHistory === null ? activeEndpoint?.endpointId ?? null : null;
  useEffect(() => {
    // 后台完成提醒只保存在当前页面内存中：非当前查看的在线 Pi 由运行中变为空闲时出现，打开该会话后消失。
    const previous = previousWorkingRef.current;
    const next = new Map<string, boolean>();
    const finished: string[] = [];
    for (const endpoint of endpoints) {
      if (endpoint.online === false) continue;
      next.set(endpoint.endpointId, endpoint.working === true);
      if (previous.get(endpoint.endpointId) === true && endpoint.working !== true && endpoint.endpointId !== viewingEndpointId) finished.push(endpoint.endpointId);
    }
    previousWorkingRef.current = next;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setCompletedEndpointIds((current) => {
        const updated = new Set([...current, ...finished].filter((endpointId) => next.has(endpointId) && endpointId !== viewingEndpointId));
        return updated.size === current.size && [...updated].every((endpointId) => current.has(endpointId)) ? current : updated;
      });
    });
    return () => { cancelled = true; };
  }, [endpoints, viewingEndpointId]);
  if (startupState === "loading") return <StartupLoading />;
  if (startupState === "error") return <StartupErrorView error={startupError} onRetry={() => window.location.reload()} />;
  const canAttach = connection === "online" && attachments.snapshot.capability.status === "supported" && !attachments.snapshot.active;
  // 选择其他 Pi：只有一个在线时直接进入，多个时回到主区选择列表。
  const chooseOtherPi = () => { if (onlinePis.length === 1) openLiveEndpoint(onlinePis[0]!.endpointId); else setExitedEndpoint(null); };
  const openLatestHistory = historySessions[0] ? () => selectHistory(historySessions[0]!) : undefined;
  const navigation: WorkspaceNavigationProps = { devices, endpoints, history: navigationHistory, activeDeviceId, activeEndpointId, selectedHistoryId: selectedHistory?.id ?? null, snapshotReady, pairingPresence, completedEndpointIds, onPair: openPairing, onSettings: () => openSettings({ kind: "workspace" }), onSelectDevice: (deviceId) => { if (deviceId !== activeDeviceId) navigate(() => selectDevice(deviceId)); }, onSelectEndpoint: selectLiveEndpoint, onSelectHistory: selectHistory, onRename: (device) => { setRenameFocusOrigin(focusedElement()); setRenameDevice(device); }, onRemove: (device) => requestConfirmation({ kind: "remove-pairing", label: displayDevice(device), device }) };
  const computerName = activeDevice ? displayDevice(activeDevice) : t.navigation.fallbackLabel;
  const connectionStatus = <ConnectionStatus state={displayConnection} retryAttempt={retryAttempt} />;
  const historyEndpoint = selectedHistory ? endpoints.find((endpoint) => endpoint.deviceId === selectedHistory.deviceId && endpoint.endpointId === selectedHistory.endpointId) ?? null : null;
  const titleBar: PwaWorkspaceTitleBar = selectedHistory
    ? { title: historySessionTitle(selectedHistory), showTitle: true, kicker: t.navigation.historyReadOnly, moreMenu: <SessionActionsMenu info={{ name: historySessionTitle(selectedHistory), cwd: historyEndpoint?.cwd ?? null, computer: computerName, status: t.common.readOnly }} /> }
    : activeDevice && displayEndpoint
      ? { title: displayPi(displayEndpoint), prefix: cwdName(displayEndpoint.cwd), showTitle: true, status: exitedDisplay ? <span className="pwa-connection offline"><span className="pwa-status-dot" aria-hidden="true" />{t.workspace.exited}</span> : connectionStatus, navigationNotice: completedEndpointIds.size > 0, moreMenu: <SessionActionsMenu info={{ name: displayPi(displayEndpoint), cwd: displayEndpoint.cwd ?? null, computer: computerName, status: exitedDisplay ? t.workspace.exited : displayEndpoint.working ? t.actions.running : t.actions.idle }} /> }
      // 没有配对或未选中电脑时，移动顶栏显示品牌名（不翻译），不把「导航」当标题。
      : { title: activeDevice ? computerName : "Pi Reach", showTitle: false, status: devices.length > 0 ? connectionStatus : null, navigationNotice: completedEndpointIds.size > 0 };
  const connectionBannerKind = connectionBannerDue ? rawConnectionBannerKind : null;
  // 新会话无消息时显示目录 · 模型 · 思考级别，发送前就能确认对象；缺哪项省略哪项。
  const emptySessionContext = displayEndpoint
    ? [cwdName(displayEndpoint.cwd), currentModel?.name ?? displayEndpoint.model ?? null, displayEndpoint.thinking ? t.commands.thinkingLevelValue(activeThinking) : null].filter(Boolean).join(" · ") || null
    : null;
  const liveTimeline = <MessageList items={timelineItems.filter((item) => !isQueuedMessage(item))} hasEarlier={hasEarlier} loadingEarlier={loadingEarlier} onLoadEarlier={loadEarlier} listRef={messageListRef} bottomSentinelRef={bottomSentinelRef} onScroll={handleScroll} isLive={connection === "online"} fileSourceCurrent emptyContext={emptySessionContext} running={displayEndpoint?.working === true} onReadingChange={onToolReading} reconnectPhase={reconnectPhase} loading={sessionLoading || sessionSkeletonVisible} skeletonVisible={sessionSkeletonVisible} topNotice={sessionSwitched ? t.workspace.sessionSwitched : null} onRetryUnknown={(requestId) => { const retry = timelineRuntimeRef.current.retryUnknown(requestId); if (retry && channelRef.current?.send(retry.frame)) applyTimelineChange(retry.change); }} />;
  const mainContent = selectedHistory
    ? <HistoryWorkspace key={selectedHistory.id} items={historyItems} restoreScrollTop={historyRestoreScrollTop} listRef={messageListRef} bottomSentinelRef={bottomSentinelRef} onBackToLive={historyEndpoint && historyEndpoint.online !== false ? () => selectLiveEndpoint(historyEndpoint.endpointId) : undefined} />
    : activeDevice && displayEndpoint
      ? <LiveWorkspace timeline={liveTimeline} footer={exitedDisplay ? <div className="pwa-read-only-bar" role="note"><span>{t.workspace.exitedNote}</span>{onlinePis.length > 0 ? <Button variant="transparent" color="piReach" type="button" onClick={chooseOtherPi}>{t.workspace.chooseOtherPi}</Button> : null}</div> : <><PwaMessageActions show={connection === "offline" || catchupFailed || !followingOutput || unreadOutput > 0} showRetry={connection === "offline" || catchupFailed} showLatest={!followingOutput || unreadOutput > 0} unreadOutput={unreadOutput} onRetry={() => { if (catchupFailed) void retryCatchup(); else retryCurrentSession(); }} onLatest={showLatest} /><MessageComposer queuedMessages={<QueuedMessagesPanel items={timelineItems} isOnline={connection === "online"} runtimeRef={timelineRuntimeRef} channelRef={channelRef} applyChange={applyTimelineChange} onError={setError} />} attachments={attachments.items} canAttach={canAttach} sendingAttachments={attachments.snapshot.active} attachmentNotice={attachments.notice} isOnline={connection === "online"} isWorking={displayEndpoint.working === true} stopping={stopRequestId !== null} draft={draft} onDraftChange={(value) => { draftVersionRef.current += 1; setDraftFor(draftKey, value); }} onSend={sendMessage} onStop={stopCurrentTask} onAddFiles={attachments.addFiles} onRemoveAttachment={attachments.remove} onRetryAttachment={attachments.retry} commandModels={models} commandCurrentModel={currentModel} commandCurrentModelFallback={displayEndpoint.model ?? null} commandThinking={activeThinking} commandPendingAction={pendingAction?.action ?? null} onNewSession={() => requestConfirmation({ kind: "new-session" })} onCompactSession={() => sendCommandAction({ action: "session_compact" })} onSetModel={(model) => sendCommandAction({ action: "model_set", provider: model.provider, modelId: model.id })} onSetThinking={(level) => sendCommandAction({ action: "thinking_set", level })} onCommandsOpen={requestModels} /></>} />
      : skeletonVisible || mainLoading
        ? <WorkspaceSkeleton visible={skeletonVisible} />
        : devices.length === 0
          ? <UnpairedWorkspace onPair={openPairing} />
          : placeholderKind === "choose-computer"
            ? <ChooseComputerWorkspace />
            : placeholderKind === "choose-pi"
              ? <ChoosePiWorkspace endpoints={onlinePis} completedEndpointIds={completedEndpointIds} onSelect={openLiveEndpoint} />
              : <NoPiWorkspace onViewHistory={openLatestHistory} />;
  return <PublishedFilesProvider value={fileView}><PwaWorkspaceLayout navigation={navigation} titleBar={titleBar} historyMode={selectedHistory !== null} connectionBanner={connectionBannerKind ? <PwaConnectionBanner kind={connectionBannerKind} connection={displayConnection} onRetry={retryCurrentSession} retryDisabled={retryPending} /> : null} toast={<PwaStatusToast message={selectedHistory ? historyError : error} onDismiss={() => { if (selectedHistory) setHistoryError(null); else setError(null); }} />} operationNotifications={standalone ? <PwaOperationNotifications controller={operationNotifications} /> : null} settingsRoute={settingsRoute} onOpenSettings={openSettings} onSettingsBack={closeSettings} renderSettings={({ backLabel, titleRef }) => <SettingsPage relayUrl={relayUrl} defaultRelayUrl={defaultRelayUrl} relayVersion={relayVersion} relayStatus={relayStatus} extensionVersion={extensionVersion} extensionStatus={connection} extensionTarget={sessionOnline && activeDevice && activeEndpoint ? `${displayDevice(activeDevice)} · ${displayPi(activeEndpoint)}` : null} onSave={saveRelayUrl} onBack={closeSettings} backLabel={backLabel} titleRef={titleRef} onClearData={() => requestConfirmation({ kind: "clear-local-data" })} onResetLayout={() => resetOutputFollowing()} />} overlays={<>{renameDevice ? <RenamePairingDialog device={renameDevice} onSave={(nickname) => saveDeviceNickname(renameDevice, nickname)} onClose={() => setRenameDevice(null)} focusOrigin={renameFocusOrigin} focusFallbackSelectors={[".pwa-session-sheet .pwa-navigation-close", ".pwa-session-trigger"]} /> : null}
    <PairingDialog opened={pairing.state !== "idle"} connecting={pairing.state === "pairing"} error={pairing.error} onSubmit={(code) => { void pairing.pairFromCode(code); }} onClearError={pairing.clearError} onClose={pairing.close} focusOrigin={pairingFocusOrigin} focusFallbackSelectors={[".pwa-session-trigger"]} />
    <ConfirmActionDialog action={confirmAction?.kind === "remove-pairing" ? { kind: "remove-pairing", label: confirmAction.label } : confirmAction} fetchingFiles={fileView.active && (confirmAction?.kind !== "remove-pairing" || isActiveDevice(confirmAction.device.id))} pending={confirmPending} error={confirmError} onConfirm={() => { void confirmRequestedAction(); }} onClose={() => { if (!confirmPendingRef.current) { setConfirmAction(null); setConfirmError(null); } }} onExitTransitionEnd={finishConfirmationTransition} /></>} closeBackgroundOverlay={closeBackgroundOverlay}>{mainContent}</PwaWorkspaceLayout></PublishedFilesProvider>;
}
