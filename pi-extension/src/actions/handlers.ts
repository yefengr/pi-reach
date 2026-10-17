/**
 * Plan/28 Wave B — typed action handlers.
 *
 * Each handler maps one `ClientMessage` action to a public Pi SDK call,
 * and replies with `action_ok` or `action_error`. Handlers take their
 * dependencies as parameters so the index.ts wiring is one-liner and
 * unit tests can pass fakes without touching global state.
 *
 * `models_list` lives next door because it shares the `ModelRegistry`
 * helper and the same wire vocabulary.
 *
 * SDK API surface used (see plan/28 Wave 0 for the full table):
 *
 *   - `ctx.compact()`            — non-blocking, fires `session_compact`
 *                                  event when done
 *   - `ctx.newSession()`         — only on `ExtensionCommandContext`;
 *                                  resolves with `{cancelled}` flag
 *   - `pi.setModel(model)`       — returns `false` if no auth configured
 *   - `pi.setThinkingLevel(lvl)` — synchronous; read actual via getThinkingLevel
 *   - `ctx.model`                — live public model getter
 *   - `ModelRegistry.{refresh,getAvailable,find}` — see `registry.ts`
 */

import type {
  ClientMessage,
  ServerMessage,
  WireModel,
  ActionName,
  ThinkingLevel,
} from "../protocol/types.js";

/**
 * Structural subset of the SDK's `Model<Api>` interface (defined in
 * `@earendil-works/pi-ai`, which is a transitive dep — not re-exported by
 * `@earendil-works/pi-coding-agent`'s main entry). Capturing just the
 * fields we touch keeps the handler decoupled from the SDK's full Model
 * surface and avoids a direct dep on `pi-ai`.
 */
export interface SdkModelLike {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow: number;
  /** Plan/30: accepted input modalities. The SDK's `Model.input` is
   *  `("text" | "image")[]`; we read `includes("image")` for the `vision`
   *  flag. Optional here so tests can omit it (treated as text-only). */
  input?: ("text" | "image")[];
}
// `Model` is the alias used throughout the file. Real SDK models structurally
// satisfy this — `pi.setModel(model)` accepts them because TypeScript
// validates structurally at the call site (the SDK's full Model has more
// fields than we declare here, which is fine for an input parameter).
type Model<_TApi = unknown> = SdkModelLike;

/** Identity used when a full SDK model object is unavailable. */
export interface CurrentModelRef {
  provider: string;
  id: string;
}

/** Legacy labels remain accepted for callers that predate structured identity. */
export type CurrentModelHint = Model<any> | CurrentModelRef | string;

/**
 * Minimal channel surface needed to reply. Mirrors `PlainPeerChannel`'s
 * `.send` signature; tests pass an array-backed fake.
 */
export interface ActionReplySender {
  send(msg: ServerMessage): void;
}

/**
 * Narrow shape of the `ExtensionAPI` surface action handlers actually
 * call. Lets the test layer stub just these without rebuilding the full
 * SDK type (which has 30+ methods we don't use here).
 */
export interface ActionPi {
  setModel(model: Model<any>): Promise<boolean>;
  setThinkingLevel(level: ThinkingLevel): void;
  getThinkingLevel(): ThinkingLevel;
}

/**
 * Narrow shape of the per-call context. Drawn from the union of
 * `ExtensionContextActions` (compact, getModel) and
 * `ExtensionCommandContextActions` (newSession), since index.ts caches
 * the most-recent ctx and that's typically the command one.
 *
 * All fields are optional so a missing method (e.g. when only a plain
 * `ExtensionContext` was seen) becomes a typed `action_error` instead of
 * a runtime TypeError.
 */
export interface ActionCtx {
  compact?: (options?: {
    customInstructions?: string;
    onComplete?: (result: unknown) => void;
    onError?: (error: Error) => void;
  }) => void;
  sessionManager?: { getSessionId(): string };
  /**
   * Starts a new session. `withSession` is the SDK's blessed hook for
   * post-replacement work: it receives a FRESH, command-capable ctx bound to
   * the new session. The SDK marks any ctx captured BEFORE this call stale, so
   * callers must re-capture via `withSession` rather than reuse the old ctx.
   */
  newSession?: (options?: {
    withSession?: (ctx: ActionCtx) => Promise<void>;
  }) => Promise<{ cancelled: boolean }>;
  /** SDK 1.3.0 exposes the active model as a live public context getter. */
  model?: Model<any>;
  /** Compatibility path for SDK contexts that expose the getter only. */
  getModel?: () => Model<any> | undefined;
  /**
   * Models enabled for session cycling by `--models` or `enabledModels`.
   * Empty means no explicit scope, so all available models remain usable.
   */
  scopedModels?: readonly { model: Model<any> }[];
  /**
   * Live session registry from Pi's extension ctx. Includes providers/models
   * registered dynamically via `pi.registerProvider(...)`, unlike the fallback
   * disk-backed registry Pi Reach can build on its own.
   */
  modelRegistry?: ActionModelRegistry;
}

/**
 * Minimal shape of the registry surface. Maps 1:1 onto `ModelRegistry`
 * but lets tests fake catalogs without instantiating the real one.
 */
export interface ActionModelRegistry {
  refresh(): void;
  getAvailable(): Model<any>[];
  find(provider: string, modelId: string): Model<any> | undefined;
}

/** Project a SDK `Model<Api>` onto the wire schema. Shared by list_models
 *  and the `current` echo, so both stay in lockstep. */
export function wireFromModel(model: Model<any>): WireModel {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    reasoning: model.reasoning,
    context_window: model.contextWindow,
    // Plan/30: vision = model accepts image input. `Model.input` is
    // `("text" | "image")[]` at runtime (confirmed against pi-ai). `?.` guards
    // a fake/partial model in tests → treated as text-only.
    vision: model.input?.includes("image") ?? false,
  };
}

// ── ack helpers ────────────────────────────────────────────────────────────

function fail(
  sender: ActionReplySender,
  msg: { id: string },
  action: ActionName,
  err: unknown,
): void {
  const error = err instanceof Error ? err.message : String(err);
  sender.send({ type: "action_error", in_reply_to: msg.id, action, error });
}

/** Run an async action with uniform success/failure replies. */
async function runAsync(
  sender: ActionReplySender,
  msg: { id: string },
  action: ActionName,
  body: () => Promise<Extract<ServerMessage, { type: "action_ok" }>>,
): Promise<boolean> {
  try {
    sender.send(await body());
    return true;
  } catch (e) {
    fail(sender, msg, action, e);
    return false;
  }
}

// ── individual handlers ───────────────────────────────────────────────────

type SessionCompactMsg = Extract<ClientMessage, { type: "session_compact" }>;
type SessionNewMsg = Extract<ClientMessage, { type: "session_new" }>;
type ModelSetMsg = Extract<ClientMessage, { type: "model_set" }>;
type ThinkingSetMsg = Extract<ClientMessage, { type: "thinking_set" }>;
type ListModelsMsg = Extract<ClientMessage, { type: "list_models" }>;

export function handleSessionCompact(
  ctx: ActionCtx | null,
  sender: ActionReplySender,
  msg: SessionCompactMsg,
  onSettled?: () => void,
): void {
  let accepted = false;
  let settled = false;
  let deferred: (() => void) | undefined;
  const finish = (success: boolean): void => {
    if (settled) return;
    settled = true;
    const reply = (): void => {
      if (success) sender.send({ type: "action_ok", in_reply_to: msg.id, action: "session_compact", phase: "completed" });
      else fail(sender, msg, "session_compact", new Error("Context compaction failed or was cancelled."));
      onSettled?.();
    };
    // SDK fakes and extension hooks may complete synchronously inside compact().
    if (accepted) reply(); else deferred = reply;
  };
  try {
    if (!ctx?.compact) throw new Error("compact unavailable (no active session ctx)");
    ctx.compact({
      customInstructions:
        "Always write the compaction summary in English, even if the conversation is in another language.",
      onComplete: () => finish(true),
      onError: () => finish(false),
    });
    sender.send({ type: "action_ok", in_reply_to: msg.id, action: "session_compact", phase: "accepted" });
    accepted = true;
    deferred?.();
  } catch {
    if (!accepted) {
      settled = true;
      fail(sender, msg, "session_compact", new Error(ctx?.compact ? "Context compaction could not start." : "compact unavailable (no active session ctx)"));
      onSettled?.();
    }
  }
}

export async function handleSessionNew(
  ctx: ActionCtx | null,
  sender: ActionReplySender,
  msg: SessionNewMsg,
  onReplaced?: (freshCtx: ActionCtx) => void,
): Promise<boolean> {
  // The bridge sends this result before finishing the old-owner handoff.
  return runAsync(sender, msg, "session_new", async () => {
    if (!ctx?.newSession) throw new Error("newSession unavailable (no command ctx yet)");
    // newSession marks the caller's captured ctx (index.ts's `_lastCtx`) STALE
    // — reusing it later throws "stale after session replacement" (the
    // compact-after-New-session crash). `withSession` hands back a fresh,
    // command-capable ctx bound to the new session; forward it via onReplaced
    // so the caller re-captures and keeps later actions off the stale ctx.
    let sessionId: string | undefined;
    const result = await ctx.newSession({
      withSession: async (freshCtx) => {
        sessionId = freshCtx.sessionManager?.getSessionId();
        onReplaced?.(freshCtx);
      },
    });
    // `cancelled: true` happens when the SDK's hook chain vetoes the new
    // session (e.g. an extension's `session_before_switch` returned a
    // refusal). Surface as a typed error rather than silent success.
    if (result.cancelled) throw new Error("cancelled by extension hook");
    if (!sessionId) throw new Error("new session identity unavailable");
    return { type: "action_ok", in_reply_to: msg.id, action: "session_new", session_id: sessionId };
  });
}

export function handleThinkingSet(
  pi: ActionPi,
  sender: ActionReplySender,
  msg: ThinkingSetMsg,
): void {
  try {
    pi.setThinkingLevel(msg.level);
    sender.send({ type: "action_ok", in_reply_to: msg.id, action: "thinking_set", thinking_level: pi.getThinkingLevel() });
  } catch (error) {
    fail(sender, msg, "thinking_set", error);
  }
}

export async function handleModelSet(
  pi: ActionPi,
  ctx: ActionCtx | null,
  reg: ActionModelRegistry,
  sender: ActionReplySender,
  msg: ModelSetMsg,
  onPersist?: (provider: string, modelId: string) => void,
  onModelSet?: (model: Model<any>) => void,
): Promise<void> {
  await runAsync(sender, msg, "model_set", async () => {
    // Prefer Pi's LIVE session registry when available so the app sees models
    // registered dynamically by extensions via `pi.registerProvider(...)`.
    // Fall back to Pi Reach's own disk-backed registry when no ctx exists.
    const liveReg = ctx?.modelRegistry ?? reg;
    // Refresh first so a model just-added via `/login` is visible.
    liveReg.refresh();
    const model = liveReg.find(msg.provider, msg.model_id);
    if (!model) {
      throw new Error(`model "${msg.provider}/${msg.model_id}" not in registry`);
    }
    const success = await pi.setModel(model);
    if (!success) throw new Error("no auth configured for this model");
    // `pi.setModel` only sets the LIVE model — it does NOT persist. Without
    // this, a model picked from the app reverts to the saved default on the
    // next Pi restart (the TUI persists because AgentSession.setModel
    // writes the default; this path doesn't). `onPersist` writes the new
    // default so the app's choice survives. Best-effort — the caller's writer
    // must not throw, so a failed settings write never fails the model change.
    const actualModel = ctx?.model;
    if (!actualModel) throw new Error("active model unavailable after model change");
    const thinkingLevel = pi.getThinkingLevel();
    try {
      onModelSet?.(actualModel);
    } catch {
      // State synchronization must not turn a successful model change into an error.
    }
    onPersist?.(actualModel.provider, actualModel.id);
    return { type: "action_ok", in_reply_to: msg.id, action: "model_set", model: wireFromModel(actualModel), thinking_level: thinkingLevel };
  });
}

function uniqueModelMatch(
  available: readonly Model<any>[],
  predicate: (model: Model<any>) => boolean,
): Model<any> | undefined {
  const matches = available.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

function isFullModel(value: CurrentModelHint): value is Model<any> {
  if (typeof value === "string" || !value || typeof value !== "object") return false;
  const candidate = value as Partial<SdkModelLike>;
  return typeof candidate.id === "string"
    && typeof candidate.name === "string"
    && typeof candidate.provider === "string"
    && typeof candidate.reasoning === "boolean"
    && typeof candidate.contextWindow === "number";
}

function resolveCurrentModel(
  ctx: ActionCtx | null,
  available: readonly Model<any>[],
  hint?: CurrentModelHint,
): Model<any> | undefined {
  // SDK 1.3.0 exposes a live model getter; re-read it even after failed writes.
  const actual = ctx?.model;
  if (actual) return actual;
  if (hint) {
    if (typeof hint !== "string") {
      if (isFullModel(hint)) return hint;
      return uniqueModelMatch(
        available,
        (model) => model.provider === hint.provider && model.id === hint.id,
      );
    }

    // String matching is retained only as a conservative legacy fallback.
    return uniqueModelMatch(
      available,
      (model) => model.id === hint || model.name === hint,
    );
  }

  return ctx?.getModel?.();
}

export function getModelsList(
  ctx: ActionCtx | null,
  reg: ActionModelRegistry,
  thinkingLevel: ThinkingLevel,
  currentModelHint?: CurrentModelHint,
): { models: WireModel[]; current?: WireModel; thinking_level: ThinkingLevel } {
  // Prefer Pi's LIVE session registry when available so the app sees models
  // registered dynamically by extensions via `pi.registerProvider(...)`.
  // Fall back to Pi Reach's own disk-backed registry when no ctx exists.
  const liveReg = ctx?.modelRegistry ?? reg;
  liveReg.refresh();
  const available = liveReg.getAvailable();
  const scopedModels = ctx?.scopedModels;
  const listedModels = scopedModels && scopedModels.length > 0
    ? scopedModels.map(({ model }) => model)
    : available;
  const models = listedModels.map(wireFromModel);
  const current = resolveCurrentModel(ctx, available, currentModelHint);
  return { models, ...(current ? { current: wireFromModel(current) } : {}), thinking_level: thinkingLevel };
}

export function handleListModels(
  ctx: ActionCtx | null,
  reg: ActionModelRegistry,
  sender: ActionReplySender,
  msg: ListModelsMsg,
  pi: Pick<ActionPi, "getThinkingLevel">,
): void {
  // refresh() can throw if `models.json` is malformed — wrap in try so the
  // app gets an explicit error reply instead of a silent drop.
  try {
    sender.send({ type: "models_list", in_reply_to: msg.id, ...getModelsList(ctx, reg, pi.getThinkingLevel()) });
  } catch (e) {
    sender.send({
      type: "error",
      in_reply_to: msg.id,
      code: "internal_error",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
