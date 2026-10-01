#!/usr/bin/env node
/** One local Pi process is one stable Relay endpoint with replaceable sessions. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { canonicalizeEd25519PublicKey } from "./pairing/crypto.js";
import { qrSession } from "./pairing/qr.js";
import { addPeer, conditionalRollbackPeer, getOrCreateEd25519Keypair, KeyringUnavailableError, PairedIdentityMissingError, listPeers, type PeerRecord } from "./pairing/storage.js";
import { idSchema, type ClientFrame, type ServerFrame } from "./protocol/v2/index.js";
import { RelayClient, type HostConnectOptions } from "./transport/relay_client.js";
import { V2PeerChannel, type HostRouteIdentity } from "./transport/peer_channel.js";
import { TimelineV2Service, type V2ActionFrame } from "./timeline/v2_service.js";
import { TimelineRuntime } from "./timeline/runtime.js";
import { UserDeliveryBinding } from "./timeline/user_delivery_binding.js";
import { handleListModels, handleModelSet, handleSessionCompact, handleThinkingSet, getModelsList, type ActionCtx, type ActionReplySender, type CurrentModelHint } from "./actions/handlers.js";
import { ensureModelRegistry } from "./actions/registry.js";
import { SessionNewBridge } from "./actions/session_new_bridge.js";
import { defaultAgentName, loadLocalConfig } from "./session/local_config.js";
import { resolveRelayUrl, toWebSocketUrl } from "./config.js";
import { persistModelDefault, registerCommands, type RemoteCommandDependencies } from "./commands.js";
import { installOwnerRouter } from "./runtime/owner_router.js";
import { RelayLifecycle, type RelayStartContext } from "./runtime/relay_lifecycle.js";
import { PairingCoordinator } from "./runtime/pairing_coordinator.js";
import { ExtensionOwner } from "./runtime/extension_owner.js";
import { buildEndpointMetadata, currentSessionName } from "./runtime/endpoint_metadata.js";
import { clearLegacyRelayStatuses, renderRelayFooter } from "./runtime/footer.js";
export type { RelayConnectivity, RemoteState } from "./runtime/relay_lifecycle.js";
const CTRL_PREFIX = "\x00pi-reach-ctrl:";
const CONTROL_PROTOCOL_VERSION = 2;
const EXTENSION_VERSION = readExtensionVersion();
const RUNTIME_CONTROL_STATUS_KEY = "pi-reach:control";
type ProcessIdentity = Readonly<{ endpointId: string; runtimeInstanceId: string }>;
type EndpointGlobal = typeof globalThis & { [key: symbol]: ProcessIdentity | undefined };
const PROCESS_IDENTITY_KEY = Symbol.for("pi-reach.endpoint-process-identity");

/** One Pi process owns a fresh endpoint identity; extension reloads reuse it. */
export function processEndpointIdentity(): ProcessIdentity {
  const global = globalThis as EndpointGlobal;
  const existing = global[PROCESS_IDENTITY_KEY];
  if (existing) return existing;
  const identity = Object.freeze({ endpointId: randomUUID(), runtimeInstanceId: randomUUID() });
  global[PROCESS_IDENTITY_KEY] = identity;
  return identity;
}

const endpointIdentity = processEndpointIdentity();
// Keep the resolved model object so current-model capabilities and identity stay
// tied to the same provider/id; the wire metadata still uses only its label.
let currentModel: CurrentModelHint | undefined;
let currentThinking: string | undefined;
let working = false;
let currentSessionManager: SessionManager | null = null;
let timeline: TimelineRuntime | null = null;
let piApi: ExtensionAPI | null = null;
let footerCtx: Pick<ExtensionContext, "ui" | "mode"> | null = null;
let lastCommandCtx: Pick<ExtensionContext, "ui" | "abort" | "cwd"> | null = null;
let lastEventCtx: Pick<ExtensionContext, "ui" | "abort" | "compact" | "isIdle"> | null = null;
let currentTurnId: string | null = null;
let replacedSessionId: string | null = null;
const sessionNewBridge = new SessionNewBridge({ getPi: () => piApi, onCommandContext: (ctx) => { lastCommandCtx = ctx; }, onReplaced: (ctx) => { lastCommandCtx = ctx as typeof lastCommandCtx; }, onFinished: () => finishSessionReplacement() });

function setCurrentModel(model: CurrentModelHint | undefined): void {
  currentModel = model;
}

function currentModelNameOrId(model: CurrentModelHint | undefined): string | undefined {
  if (!model) return undefined;
  if (typeof model === "string") return model;
  return "name" in model && model.name ? model.name : model.id;
}

export const _getState = (): "idle" | "started" | "paired" => relayLifecycle.state === "idle" ? "idle" : activeOwners.size > 0 ? "paired" : "started";
export const _getCachedPublicKeyForTest = (): string | null => relayLifecycle.keypair ? Buffer.from(relayLifecycle.keypair.publicKey).toString("base64") : null;
export const _getCurrentTurnIdForTest = (): string | null => currentTurnId;
export const _setPiForTest = (value: unknown): void => { piApi = value as ExtensionAPI; };
export const _setCurrentModelForTest = (value: CurrentModelHint | undefined): void => { currentModel = value; };
export const _hasPendingReconnect = (): boolean => relayLifecycle.hasPendingReconnect;
export const _getActivePeerCountForTest = (): number => activeOwners.size;
export const _hasActivePeerForTest = (ownerId: string): boolean => activeOwners.has(ownerId);
export const _getDisposedForTest = (): boolean => relayLifecycle.disposed;
export const _setDisposedForTest = (value: boolean): void => { relayLifecycle.setDisposed(value); };
export const _setSessionNewBridgeTimeoutForTest = (timeoutMs: number): void => sessionNewBridge.setTimeoutForTest(timeoutMs);
function displayName(cwd = process.cwd()): string { return loadLocalConfig(cwd).agent_name ?? defaultAgentName(cwd); }

function endpointMetadata(cwd = process.cwd()) {
  return buildEndpointMetadata({
    sessionManager: currentSessionManager,
    cwd,
    model: currentModelNameOrId(currentModel),
    thinking: currentThinking,
    working,
  });
}

function routeIdentity(): HostRouteIdentity {
  const keypair = relayLifecycle.keypair;
  if (!keypair) throw new Error("pi-reach identity is unavailable");
  return { deviceId: Buffer.from(keypair.publicKey).toString("base64"), endpointId: endpointIdentity.endpointId, runtimeInstanceId: endpointIdentity.runtimeInstanceId };
}

async function authorizedOwnerIds(): Promise<string[]> {
  const owners = new Set<string>();
  for (const record of await listPeers()) {
    try { owners.add(canonicalizeEd25519PublicKey(record.remote_epk, "stored Owner public key")); }
    catch { /* malformed legacy records have no Relay authority */ }
  }
  return [...owners];
}

function relayStatus() { return relayLifecycle.status; }

function emitRuntimeEvent(type: string, details: Record<string, unknown>): void {
  try { piApi?.sendMessage({ customType: `pi-reach:${type}`, content: "", details, display: false }); }
  catch { /* a stale session must not take down the process */ }
}

function emitRelayState(): void {
  emitRuntimeEvent("relay-state", { state: relayStatus(), endpoint_id: endpointIdentity.endpointId, runtime_instance_id: endpointIdentity.runtimeInstanceId });
}

function emitRuntimeReady(ctx: Pick<ExtensionContext, "ui" | "mode">): void {
  const details = {
    control_protocol_version: CONTROL_PROTOCOL_VERSION,
    extension_version: EXTENSION_VERSION,
    endpoint_id: endpointIdentity.endpointId,
    runtime_instance_id: endpointIdentity.runtimeInstanceId,
    ...(currentSessionManager ? { session_id: currentSessionManager.getSessionId() } : {}),
  };
  emitRuntimeEvent("runtime-ready", details);
  if (ctx.mode !== "rpc") return;
  try { ctx.ui.setStatus(RUNTIME_CONTROL_STATUS_KEY, JSON.stringify({ type: "runtime_ready", ...details })); }
  catch { /* stale RPC UI context */ }
}

function emitRuntimeFailed(stage: string, code: string, message: string, retryable: boolean): void {
  emitRuntimeEvent("runtime-failed", { stage, code, message, retryable });
}

let endpointUpdateQueue: Promise<void> = Promise.resolve();

function updateEndpoint(expectedRelay?: RelayClient): Promise<boolean> {
  let sent = false;
  const operation = endpointUpdateQueue.then(async () => {
    const relay = expectedRelay ?? relayLifecycle.relay;
    if (!relay?.isOpen() || !relayLifecycle.isCurrent(relay)) return;
    try {
      const authorized = await authorizedOwnerIds();
      if (!relayLifecycle.isCurrent(relay) || !relay.isOpen()) return;
      sent = relay.sendControl({
        type: "endpoint_update",
        metadata: endpointMetadata(),
        authorized_owner_ids: authorized,
      });
    } catch { /* reconnect owns recovery */ }
  });
  endpointUpdateQueue = operation.then(() => undefined, () => undefined);
  return operation.then(() => sent);
}

function publishPairingOffer(code: string, expiresAt: number, expectedRelay?: RelayClient): boolean {
  const invite = qrSession.getActiveInvite();
  const relay = expectedRelay ?? relayLifecycle.relay;
  if (!invite || invite.code !== code || invite.expiresAt !== expiresAt || expiresAt <= Date.now()) return false;
  if (!relay?.isOpen() || !relayLifecycle.isCurrent(relay)) return false;
  return relay.sendControl({
    type: "pairing_offer",
    code,
    endpoint_id: endpointIdentity.endpointId,
    runtime_instance_id: endpointIdentity.runtimeInstanceId,
    expires_at: expiresAt,
  });
}

function republishPairingOffer(relay: RelayClient): void {
  const invite = qrSession.getActiveInvite();
  if (!invite) return;
  publishPairingOffer(invite.code, invite.expiresAt, relay);
}

function refreshFooter(): void {
  if (!footerCtx || (footerCtx.mode !== "tui" && footerCtx.mode !== "rpc")) return;
  const { ui, mode } = footerCtx;
  try {
    if (mode === "tui") {
      clearLegacyRelayStatuses(ui);
      renderRelayFooter(ui, relayLifecycle.displayStatus);
    }
    ui.setTitle(`${displayName()} · ${relayLifecycle.state === "idle" ? "Off" : "On"}`);
  } catch { /* stale UI context */ }
}

type OwnerBinding = { channel: V2PeerChannel; service: TimelineV2Service; sessionId: string; leafId: string | null };

const activeOwners = new Map<string, OwnerBinding>();
const userDelivery = new UserDeliveryBinding({
  isIdle: () => lastEventCtx?.isIdle() ?? false,
  canAcceptNormal: () => piApi !== null && lastEventCtx !== null,
  getPi: () => piApi,
  getTimeline: () => timeline,
  getCurrentSessionId: () => currentSessionManager?.getSessionId() ?? null,
  getCurrentLeafId: () => currentSessionManager?.getLeafId() ?? null,
  findTarget: (ownerId) => activeOwners.get(ownerId) ?? null,
  sendFrames: (ownerId, frames) => {
    const binding = activeOwners.get(ownerId);
    if (binding) for (const frame of frames) binding.channel.sendV2(frame);
  },
});
const relayLifecycle = new RelayLifecycle({
  loadIdentity: getOrCreateEd25519Keypair,
  resolveRelayUrl,
  createClient: (url, identity) => new RelayClient(toWebSocketUrl(url), identity),
  buildConnectOptions: hostConnectOptions,
  handleIdentityError: (error, ctx) => {
    if (!(error instanceof KeyringUnavailableError) && !(error instanceof PairedIdentityMissingError)) return false;
    emitRuntimeFailed("identity", error instanceof KeyringUnavailableError ? "keyring_unavailable" : "paired_identity_missing", error.message, false);
    try { ctx.ui.notify(`[pi-reach] Cannot access the established device identity: ${error.message}`, "error"); } catch { /* stale UI context */ }
    return true;
  },
  describeConnection: (resolution) => `[pi-reach] Connecting endpoint ${endpointIdentity.endpointId.slice(0, 8)} to ${resolution.url} (source: ${resolution.source})…`,
  onStateChange: emitRelayState,
  onDisplayStatusChange: refreshFooter,
  onConnected: (client, ctx) => {
    installRouteListener(client);
    republishPairingOffer(client);
    if (!ctx) void updateEndpoint(client);
  },
  onDisconnected: () => {
    for (const ownerId of [...activeOwners.keys()]) detachOwner(ownerId);
    pairingCoordinator.abandonInactive();
  },
});

function detachOwner(ownerId: string): void {
  const binding = activeOwners.get(ownerId);
  if (!binding) return;
  userDelivery.clearOwner(ownerId, binding.service);
  try { binding.channel.detach(); } catch { /* best effort */ }
  activeOwners.delete(ownerId);
}
function closeOwner(ownerId: string, reason: "peer_stop"): void {
  const binding = activeOwners.get(ownerId);
  if (!binding) return;
  binding.channel.sendV2({
    protocol_version: 2,
    type: "bye",
    session_id: binding.sessionId,
    leaf_id: binding.service.leafId,
    reason,
  });
  detachOwner(ownerId);
}
function broadcastV2(factory: (service: TimelineV2Service) => readonly ServerFrame[]): void {
  for (const { channel, service } of activeOwners.values()) for (const frame of factory(service)) channel.sendV2(frame);
}

function finishSessionReplacement(): void {
  const sessionId = replacedSessionId;
  if (!sessionId) return;
  replacedSessionId = null;
  for (const [ownerId, { channel, service }] of [...activeOwners]) {
    channel.sendV2({ protocol_version: 2, type: "bye", session_id: sessionId, leaf_id: service.leafId, reason: "session_replaced" }); detachOwner(ownerId);
  }
}

function ensureTimeline(sessionManager: SessionManager): TimelineRuntime {
  currentSessionManager = sessionManager;
  if (!timeline) {
    timeline = new TimelineRuntime({
      onStarted: (started) => userDelivery.onStarted(started),
      onPartial: (partial) => {
        broadcastV2((service) => {
          const frame = service.partial(partial);
          return frame ? [frame] : [];
        });
      },
      onPublished: (event, correlation) => {
        broadcastV2((service) => service.publishFrames(event));
        userDelivery.onPublished(event, correlation);
      },
    });
  }
  timeline.attach(sessionManager);
  return timeline;
}

function refreshOwnerScopes(reason: "branch_changed" | "session_replaced"): void {
  userDelivery.clearAll();
  for (const { channel, service } of activeOwners.values()) {
    service.refreshScope();
    for (const frame of service.reset(reason)) channel.sendV2(frame);
  }
}

function actionSender(ownerId: string, channelId: string): ActionReplySender {
  return {
    send(message) {
      const binding = activeOwners.get(ownerId);
      if (!binding) return;
      if (message.type === "action_ok" || message.type === "action_error") {
        binding.channel.sendV2({ protocol_version: 2, type: message.type, target_channel_id: channelId, in_reply_to: message.in_reply_to, action: message.action, ...(message.type === "action_error" ? { error: message.error } : {}) } as ServerFrame);
      }
    },
  };
}

function routeAction(ownerId: string, frame: V2ActionFrame): void {
  const sender = actionSender(ownerId, frame.channel_id);
  const ctx = (lastEventCtx ?? lastCommandCtx) as ActionCtx | null;
  switch (frame.type) {
    case "session_compact":
      handleSessionCompact(ctx, sender, frame);
      return;
    case "session_new":
      sessionNewBridge.dispatch(sender, frame);
      return;
    case "model_set":
      if (piApi) void handleModelSet(piApi, ctx, ensureModelRegistry(ctx), sender, frame, persistModelDefault, setCurrentModel);
      return;
    case "thinking_set":
      if (piApi) handleThinkingSet(piApi, sender, frame);
      return;
  }
}

function createBinding(relayClient: RelayClient, ownerId: string): OwnerBinding | null {
  const manager = currentSessionManager;
  if (!manager) return null;
  const runtime = ensureTimeline(manager);
  const channel = new V2PeerChannel(relayClient, ownerId, routeIdentity(), (frame) => routeClientFrame(ownerId, frame));
  let service!: TimelineV2Service;
  service = new TimelineV2Service({
    sessionManager: manager,
    senderRef: ownerId,
    extensionVersion: EXTENSION_VERSION,
    runtime,
    onUserMessage: (frame, correlation) => {
      currentTurnId = frame.client_request_id;
      return userDelivery.submit(frame, correlation, {
        ownerId,
        sessionId: manager.getSessionId(),
        leafId: manager.getLeafId() ?? null,
        service,
        clientRequestId: frame.client_request_id,
      });
    },
    onCancel: () => {
      const abort = lastEventCtx?.abort ?? lastCommandCtx?.abort;
      if (!abort) return false;
      abort();
      return true;
    },
    onQueueSnapshot: () => userDelivery.snapshot(ownerId, service),
    onQueuedMessageClear: (targetId) => userDelivery.clearQueued(ownerId, service, targetId),
    onQueuedMessageSteer: (targetId) => userDelivery.steerQueued(ownerId, service, targetId).kind,
    onAction: (frame) => routeAction(ownerId, frame),
    onListModels: () => getModelsList((lastEventCtx ?? lastCommandCtx) as ActionCtx | null, ensureModelRegistry((lastEventCtx ?? lastCommandCtx) as ActionCtx | null), currentModel),
  });
  return { channel, service, sessionId: manager.getSessionId(), leafId: manager.getLeafId() ?? null };
}

function attachOwner(relayClient: RelayClient, ownerId: string): OwnerBinding | null {
  detachOwner(ownerId);
  const binding = createBinding(relayClient, ownerId);
  if (!binding) return null;
  activeOwners.set(ownerId, binding);
  return binding;
}

function routeClientFrame(ownerId: string, frame: ClientFrame): void {
  const binding = activeOwners.get(ownerId);
  if (!binding) return;
  for (const response of binding.service.handle(frame)) binding.channel.sendV2(response);
}

function installRouteListener(relayClient: RelayClient): () => void {
  return installOwnerRouter(relayClient, {
    isCurrent: (candidate) => relayLifecycle.isCurrent(candidate),
    routeIdentity,
    hasOwner: (ownerId) => activeOwners.has(ownerId),
    findKnownOwner: async (ownerId) => !!await findKnownOwner(ownerId),
    attachOwner,
    routeClientFrame,
    handlePairRequest,
  });
}

async function findKnownOwner(ownerId: string): Promise<PeerRecord | null> {
  let canonical: string;
  try { canonical = canonicalizeEd25519PublicKey(ownerId, "Relay Owner key"); }
  catch { return null; }
  for (const record of await listPeers()) {
    try {
      if (canonicalizeEd25519PublicKey(record.remote_epk, "stored Owner public key") === canonical) return record;
    } catch { /* bad stored record */ }
  }
  return null;
}

const pairingCoordinator = new PairingCoordinator({
  qrSession,
  routeIdentity,
  isRelayCurrent: (relay) => relayLifecycle.isCurrent(relay),
  attachOwner,
  activeBinding: (ownerId) => activeOwners.get(ownerId),
  addPeer,
  rollbackPeer: conditionalRollbackPeer,
  updateEndpoint: (relay) => updateEndpoint(relay),
  refreshCurrentEndpoint: () => updateEndpoint(),
  buildPairOk: (frame) => ({
    protocol_version: 2,
    type: "pair_ok",
    in_reply_to: frame.id,
    session_name: currentSessionName(currentSessionManager),
    session_started_at: Date.now(),
    endpoint_id: endpointIdentity.endpointId,
    harness: { name: "Pi coding agent", version: EXTENSION_VERSION },
    hostname: hostname(),
  }),
});

function handlePairRequest(relayClient: RelayClient, ownerId: string, frame: Extract<ClientFrame, { type: "pair_request" }>): Promise<void> {
  return pairingCoordinator.handle(relayClient, ownerId, frame);
}

function closeRelay(reason?: "peer_stop" | "session_replaced" | "shutdown"): void {
  userDelivery.clearAll();
  sessionNewBridge.clear("session replacement cancelled because the endpoint closed");
  qrSession.clear();
  replacedSessionId = null;
  if (reason) {
    for (const { channel, service } of activeOwners.values()) {
      channel.sendV2({ protocol_version: 2, type: "bye", session_id: currentSessionManager?.getSessionId() ?? "unknown", leaf_id: currentSessionManager?.getLeafId() ?? null, reason });
    }
  }
  relayLifecycle.stop();
}

async function hostConnectOptions(cwd = process.cwd()): Promise<HostConnectOptions> {
  return {
    role: "host",
    endpointId: endpointIdentity.endpointId,
    runtimeInstanceId: endpointIdentity.runtimeInstanceId,
    metadata: endpointMetadata(cwd),
    authorizedOwnerIds: await authorizedOwnerIds(),
  };
}

function start(ctx: RelayStartContext) { return relayLifecycle.start(ctx); }
function waitForInitialRelay() { return relayLifecycle.waitForInitial(); }

function readExtensionVersion(): string {
  const here = fileURLToPath(import.meta.url);
  const pkg = JSON.parse(readFileSync(join(dirname(dirname(here)), "package.json"), "utf8")) as { version?: unknown };
  const version = idSchema.safeParse(pkg.version);
  if (!version.success) throw new Error("Pi Reach Extension package has an invalid version");
  return version.data;
}

const APPLIED = Symbol.for("pi-reach.endpoint-extension-applied");
function appliedSet(): WeakSet<object> {
  const global = globalThis as typeof globalThis & { [APPLIED]?: WeakSet<object> };
  return global[APPLIED] ??= new WeakSet<object>();
}

const commandDependencies: RemoteCommandDependencies = {
  start,
  waitForInitialRelay,
  stop: () => closeRelay("peer_stop"),
  state: () => relayLifecycle.state,
  relayStatus,
  relayUrl: () => relayLifecycle.relayUrl,
  endpointIdentity: () => endpointIdentity,
  activeOwnerCount: () => activeOwners.size,
  isOwnerActive: (ownerId) => activeOwners.has(ownerId),
  closeOwner,
  updateEndpoint: async () => { await updateEndpoint(); },
  displayName,
  keypair: () => relayLifecycle.keypair,
  hasRelay: () => relayLifecycle.relay?.isOpen() === true,
  publishPairingOffer: (code, expiresAt) => publishPairingOffer(code, expiresAt),
  setCommandContext: (ctx) => { lastCommandCtx = ctx; footerCtx = ctx; },
  runInternalSessionNew: (token, ctx) => sessionNewBridge.run(token, ctx),
};

const extension: ExtensionFactory = (api): void => {
  if (appliedSet().has(api)) return;
  appliedSet().add(api);
  const owner = new ExtensionOwner();
  const pi = owner.guard(api);
  registerCommands(pi, commandDependencies);

  pi.on("input", (event) => {
    if (event.text.startsWith(CTRL_PREFIX)) {
      const control = event.text.slice(CTRL_PREFIX.length).trim();
      if (control === "relay:on") void start({ ui: { notify: () => undefined }, cwd: process.cwd() } as unknown as ExtensionContext);
      else if (control === "relay:off") closeRelay("peer_stop");
      else if (control === "relay:status") emitRelayState();
      return { action: "handled" } as const;
    }
    return undefined;
  });
  pi.on("session_before_switch", (event) => sessionNewBridge.beforeSwitch(event.reason)); pi.on("session_before_fork", () => sessionNewBridge.beforeFork());
  pi.on("session_info_changed", () => { void updateEndpoint(); });
  pi.on("model_select", (event) => {
    setCurrentModel(event.model as CurrentModelHint);
    void updateEndpoint();
  });
  pi.on("thinking_level_select", (event) => {
    currentThinking = event.level as string | undefined;
    void updateEndpoint();
  });
  // working 按整次运行计算，工具调用之间的 turn 边界不改变运行状态。
  pi.on("agent_start", () => { timeline?.onAgentStart(); working = true; void updateEndpoint(); });
  pi.on("agent_end", (event) => {
    timeline?.onAgentEnd(event.messages);
    working = false;
    void updateEndpoint();
    currentTurnId = null;
    userDelivery.scheduleDrain();
  });
  pi.on("agent_settled", () => userDelivery.scheduleDrain());
  pi.on("turn_end", (_event, ctx) => {
    const manager = (ctx as unknown as { sessionManager?: SessionManager }).sessionManager;
    if (manager) ensureTimeline(manager).onTurnEnd(manager);
  });
  pi.on("message_start", (event, ctx) => {
    const manager = (ctx as unknown as { sessionManager?: SessionManager }).sessionManager;
    if (manager) ensureTimeline(manager).onMessageStart(event.message, manager);
  });
  pi.on("message_update", (event, ctx) => {
    const manager = (ctx as unknown as { sessionManager?: SessionManager }).sessionManager;
    if (manager) ensureTimeline(manager).onMessageUpdate(event, manager);
  });
  pi.on("message_end", (event, ctx) => {
    const manager = (ctx as unknown as { sessionManager?: SessionManager }).sessionManager;
    if (manager) ensureTimeline(manager).onMessageEnd(event.message, manager);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    const manager = (ctx as unknown as { sessionManager?: SessionManager }).sessionManager;
    if (manager) ensureTimeline(manager).onToolExecutionStart(event, manager);
  });
  pi.on("tool_execution_update", (event, ctx) => {
    const manager = (ctx as unknown as { sessionManager?: SessionManager }).sessionManager;
    if (manager) ensureTimeline(manager).onToolExecutionUpdate(event, manager);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    const manager = (ctx as unknown as { sessionManager?: SessionManager }).sessionManager;
    if (manager) ensureTimeline(manager).onToolExecutionEnd(event, manager);
  });
  api.on("session_start", (event, ctx) => {
    if (!owner.activate(event, ctx)) return;
    piApi = api;
    lastEventCtx = ctx;
    footerCtx = ctx;
    refreshFooter();
    setCurrentModel(ctx.model);
    const manager = (ctx as unknown as { sessionManager?: SessionManager }).sessionManager;
    if (manager) {
      userDelivery.clearAll();
      currentSessionManager = manager;
      ensureTimeline(manager).resetSession(manager);
      emitRuntimeEvent("session-changed", { endpoint_id: endpointIdentity.endpointId, runtime_instance_id: endpointIdentity.runtimeInstanceId, session_id: manager.getSessionId(), leaf_id: manager.getLeafId() ?? null });
      emitRuntimeReady(ctx);
      if (!sessionNewBridge.isRunning()) finishSessionReplacement();
      void updateEndpoint();
    }
    try { currentThinking = pi.getThinkingLevel() as string | undefined; } catch { /* optional SDK capability */ }
    if (relayLifecycle.state === "idle") void start(ctx).catch((error: unknown) => {
      try { ctx.ui.notify(`[pi-reach] Startup failed: ${String(error)}`, "error"); } catch { /* stale UI context */ }
    });
  });
  pi.on("session_tree", () => refreshOwnerScopes("branch_changed"));
  api.on("session_shutdown", (event) => {
    if (!owner.isCurrent()) return;
    userDelivery.clearAll();
    footerCtx = null;
    if (event.reason !== "quit") {
      replacedSessionId = currentSessionManager?.getSessionId() ?? null;
      currentSessionManager = null;
      owner.release(event);
      return;
    }
    relayLifecycle.setDisposed(true);
    closeRelay("shutdown");
    owner.release(event);
  });
};
export default extension;
/** Compatibility seam used by focused extension tests. */
export async function _startRelayForTest(ctx: unknown): Promise<void> { await start(ctx as RelayStartContext); }
export async function _stopForTest(_ctx: unknown): Promise<void> { closeRelay("peer_stop"); }
export async function _connectForTest(ctx: unknown): Promise<void> { await start(ctx as RelayStartContext); }
