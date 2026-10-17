import { describe, expect, test, vi } from "vitest";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "../protocol/types.js";
import type { ServerFrame } from "../protocol/v2/index.js";
import { TimelineRuntime } from "../timeline/runtime.js";
import { registerCompactionActivity } from "./compaction_activity.js";
import { handleModelSet, handleSessionCompact, handleSessionNew, handleThinkingSet, handleListModels, getModelsList, wireFromModel, type ActionCtx, type ActionPi, type SdkModelLike } from "./handlers.js";

const model: SdkModelLike = { id: "requested", provider: "local", name: "Requested", reasoning: true, contextWindow: 1000 };
const actual = { ...model, id: "actual", name: "Actual" };
const registry = { refresh: () => {}, getAvailable: () => [model, actual], find: () => model };
const pi = (overrides: Partial<ActionPi> = {}): ActionPi => ({ setModel: async () => true, setThinkingLevel: () => {}, getThinkingLevel: () => "low", ...overrides });
function sender() {
  const sent: ServerMessage[] = [];
  return { sent, send: (message: ServerMessage) => { sent.push(message); } };
}

type ActivityFrame = Extract<ServerFrame, { type: "compaction_activity" }>;
function compactionActivity() {
  const hooks = new Map<string, (event: unknown, context: { sessionManager: SessionManager }) => void>();
  const api = { on: (name: string, handler: (event: unknown, context: { sessionManager: SessionManager }) => void) => { hooks.set(name, handler); } } as unknown as ExtensionAPI;
  const activity: ActivityFrame[] = [];
  const order: string[] = [];
  const runtime = new TimelineRuntime({ onPublished: (event) => { order.push(`timeline:${event.kind}`); } });
  registerCompactionActivity(api, (frame) => { activity.push(frame); order.push(`activity:${frame.status}`); },
    (entry, manager) => { runtime.publishSessionEntry(entry, manager); });
  return { activity, order, runtime, emit: (name: string, event: unknown, manager: SessionManager) => { hooks.get(name)!({ reason: "manual", ...event as object }, { sessionManager: manager }); } };
}

describe("compaction activity scope", () => {
  test.each(["manual", "threshold", "overflow"])("%s completion closes the starting leaf before the appended summary is published once", (reason) => {
    const manager = SessionManager.inMemory(process.cwd());
    const leaf = manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
    const fixture = compactionActivity();
    fixture.emit("session_before_compact", { reason }, manager);
    const id = manager.appendCompaction("formal summary", leaf, 100);
    expect(manager.getLeafId()).not.toBe(leaf);
    const compactionEntry = manager.getBranch().find((entry) => entry.id === id)!;
    fixture.emit("session_compact", { reason, compactionEntry }, manager);
    expect(fixture.activity).toEqual(["running", "completed"].map((status) => ({
      protocol_version: 2, type: "compaction_activity", session_id: manager.getSessionId(), leaf_id: leaf, reason, status,
    })));
    expect(fixture.order).toEqual(["activity:running", "activity:completed", "timeline:compaction"]);
    expect(fixture.runtime.getPublishedEvents()).toEqual([expect.objectContaining({ event_id: id, kind: "compaction", leaf_id: id })]);
    fixture.emit("session_compact", { reason, compactionEntry }, manager);
    expect(fixture.runtime.getPublishedEvents()).toHaveLength(1);
  });

  test.each([false, true])("terminal scope stays isolated by session and reason (aborted=%s)", (aborted) => {
    const first = SessionManager.inMemory(process.cwd());
    const firstLeaf = first.appendMessage({ role: "user", content: "first", timestamp: 1 });
    const second = SessionManager.inMemory(process.cwd());
    const secondLeaf = second.appendMessage({ role: "user", content: "second", timestamp: 2 });
    const fixture = compactionActivity();
    fixture.emit("session_before_compact", {}, first);
    fixture.emit("session_before_compact", {}, second);
    const unrelatedLeaf = first.appendMessage({ role: "user", content: "another branch", timestamp: 3 });
    fixture.emit("session_before_compact", { reason: "threshold" }, first);
    fixture.emit("session_compact_failed", { aborted }, first);
    expect(fixture.activity.at(-1)).toMatchObject({ session_id: first.getSessionId(), leaf_id: firstLeaf, reason: "manual", status: aborted ? "cancelled" : "failed" });
    // 当前 PWA 的严格 leaf 过滤仍会拒绝旧分支终态，不把它套在无关分支上。
    expect(fixture.activity.at(-1)?.leaf_id).not.toBe(unrelatedLeaf);
    fixture.emit("session_compact_failed", { reason: "threshold", aborted }, first);
    expect(fixture.activity.at(-1)).toMatchObject({ session_id: first.getSessionId(), leaf_id: unrelatedLeaf, reason: "threshold" });
    fixture.emit("session_compact_failed", { aborted }, second);
    expect(fixture.activity.at(-1)).toMatchObject({ session_id: second.getSessionId(), leaf_id: secondLeaf });
  });

  test("an unrelated local manual cancellation cannot settle an in-flight remote request", () => {
    const manager = SessionManager.inMemory(process.cwd());
    manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
    const fixture = compactionActivity();
    let options: Parameters<NonNullable<ActionCtx["compact"]>>[0];
    const reply = sender();
    handleSessionCompact({ sessionManager: manager, compact: (value) => { options = value; } }, reply, { type: "session_compact", id: "remote" });
    fixture.emit("session_before_compact", {}, manager);
    fixture.emit("session_compact_failed", { aborted: true }, manager);
    expect(reply.sent).toEqual([{ type: "action_ok", in_reply_to: "remote", action: "session_compact", phase: "accepted" }]);
    // 公开 hook 没有 invocation ID；没有该次调用的取消证据时，不冒认本地 hook。
    options?.onError?.(new Error("private failure"));
    expect(reply.sent[1]).toMatchObject({ type: "action_error", in_reply_to: "remote" });
  });
});

describe("operation feedback outcomes", () => {
  test.each([true, false])("synchronous compact callback preserves accepted before outcome (success=%s)", (success) => {
    const reply = sender();
    const settled = vi.fn();
    handleSessionCompact({ compact: (options) => {
      if (success) options?.onComplete?.({});
      else options?.onError?.(new Error("secret body"));
    } }, reply, { type: "session_compact", id: "compact" }, settled);
    expect(reply.sent[0]).toMatchObject({ type: "action_ok", phase: "accepted" });
    expect(reply.sent[1]).toMatchObject(success ? { type: "action_ok", phase: "completed" } : { type: "action_error", action: "session_compact" });
    expect(reply.sent).toHaveLength(2);
    expect(JSON.stringify(reply.sent)).not.toContain("secret body");
    expect(settled).toHaveBeenCalledTimes(1);
  });
  test("asynchronous compaction failure settles only its request once without leaking error", () => {
    const reply = sender();
    let options: Parameters<NonNullable<ActionCtx["compact"]>>[0];
    handleSessionCompact({ compact: (value) => { options = value; } }, reply, { type: "session_compact", id: "compact" });
    expect(reply.sent).toHaveLength(1);
    options?.onError?.(new Error("secret response"));
    options?.onComplete?.({});
    expect(reply.sent).toHaveLength(2);
    expect(reply.sent[1]).toMatchObject({ type: "action_error", in_reply_to: "compact", action: "session_compact" });
    expect(JSON.stringify(reply.sent)).not.toContain("secret response");
  });
  test("model success reads the actual live model and clamped thinking level", async () => {
    const reply = sender();
    let current = model;
    const context: ActionCtx = { get model() { return current; } };
    const persist = vi.fn();
    const sync = vi.fn();
    await handleModelSet(pi({ setModel: async () => { current = actual; return true; }, getThinkingLevel: () => "max" }), context, registry, reply,
      { type: "model_set", id: "model", provider: model.provider, model_id: model.id }, persist, sync);
    expect(reply.sent).toEqual([{ type: "action_ok", in_reply_to: "model", action: "model_set", model: wireFromModel(actual), thinking_level: "max" }]);
    expect(persist).toHaveBeenCalledWith(actual.provider, actual.id);
    expect(sync).toHaveBeenCalledWith(actual);
  });
  test("thinking success echoes the actual clamped value rather than the request", () => {
    const reply = sender();
    handleThinkingSet(pi({ getThinkingLevel: () => "off" }), reply, { type: "thinking_set", id: "thinking", level: "max" });
    expect(reply.sent[0]).toMatchObject({ thinking_level: "off" });
  });
  test("failed model mutation is followed by a read of actual configuration, without rollback", async () => {
    const reply = sender();
    let current = model;
    const context: ActionCtx = { get model() { return current; } };
    const api = pi({ setModel: async () => { current = actual; throw new Error("mutation failed"); }, getThinkingLevel: () => "off" });
    await handleModelSet(api, context, registry, reply, { type: "model_set", id: "model", provider: model.provider, model_id: model.id });
    expect(reply.sent[0]).toMatchObject({ type: "action_error" });
    handleListModels(context, registry, reply, { type: "list_models", id: "read" }, api);
    expect(reply.sent[1]).toMatchObject({ type: "models_list", current: wireFromModel(actual), thinking_level: "off" });
    expect(getModelsList(context, registry, "off", model).current).toEqual(wireFromModel(actual));
  });
  test("newSession success waits for the outer operation after capturing fresh identity", async () => {
    const reply = sender();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const replaced = vi.fn();
    const operation = handleSessionNew({ newSession: async (options) => {
      await options?.withSession?.({ sessionManager: { getSessionId: () => "target-session" } });
      await gate;
      return { cancelled: false };
    } }, reply, { type: "session_new", id: "new" }, replaced);
    await Promise.resolve();
    expect(replaced).toHaveBeenCalledTimes(1);
    expect(reply.sent).toEqual([]);
    release();
    expect(await operation).toBe(true);
    expect(reply.sent[0]).toMatchObject({ action: "session_new", session_id: "target-session" });
  });
  test("newSession without confirmed identity never claims success", async () => {
    const reply = sender();
    expect(await handleSessionNew({ newSession: async () => ({ cancelled: false }) }, reply, { type: "session_new", id: "new" })).toBe(false);
    expect(reply.sent[0]).toMatchObject({ type: "action_error" });
  });
});
