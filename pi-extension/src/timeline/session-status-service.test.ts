import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SESSION_STATUS_LEASE_MS, ServerFrameSchema, type ServerFrame } from "@pi-reach/protocol/session";
import { afterEach, expect, test, vi } from "vitest";
import { SessionStatusService } from "./session-status-service.js";
import { TimelineV2Service } from "./v2_service.js";
import { TimelineRuntime } from "./runtime.js";
import type { StatusSnapshot } from "./session-status-data.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.useRealTimers(); });
function setup() {
  vi.useFakeTimers();
  const manager = SessionManager.inMemory(process.cwd());
  let input = 0;
  const snapshot = (): StatusSnapshot => ({ sessionId: manager.getSessionId(), leafId: manager.getLeafId(), status: {
    context: null, usage: { input, output: 0, cache_read: 0, cache_write: 0, cost: 0,
      cache_hit_rate_session: null, cache_hit_rate_latest: null }, branch: null, extensions: [],
  } });
  const read = vi.fn<() => StatusSnapshot | null | Promise<StatusSnapshot | null>>(snapshot);
  const status = new SessionStatusService(read);
  cleanup.push(() => status.dispose());
  function owner(id: string) {
    const sent: ServerFrame[] = [];
    const send = vi.fn((frame: ServerFrame) => { expect(ServerFrameSchema.safeParse(frame).success).toBe(true); sent.push(frame); return true; });
    const runtime = new TimelineRuntime(); runtime.attach(manager);
    const service = new TimelineV2Service({ sessionManager: manager, runtime, senderRef: id, extensionVersion: "1.0.0",
      onUserMessage: () => false, sessionStatus: status, onSessionStatusFrame: send });
    cleanup.push(() => service.dispose());
    const hello = (channel = "c") => service.handle({ protocol_version: 2, type: "session_hello", id: "hello", channel_id: channel, tool_details: 1 });
    const subscribe = (channel = "c", id = "sub") => service.handle({ protocol_version: 2, type: "session_status_subscribe", id,
      channel_id: channel, session_id: manager.getSessionId(), leaf_id: manager.getLeafId() });
    const ping = (channel = "c") => service.handle({ protocol_version: 2, type: "ping", id: "ping", channel_id: channel,
      session_id: manager.getSessionId(), leaf_id: manager.getLeafId() });
    return { service, sent, send, hello, subscribe, ping };
  }
  return { manager, status, read, snapshot, owner, update: (value: number) => { input = value; status.changed(); } };
}

test("ready-only, owner/channel isolation, identical first responses and shared trailing computation", () => {
  const env = setup(), a = env.owner("a"), b = env.owner("b");
  expect(a.subscribe()[0]).toMatchObject({ type: "protocol_error", code: "invalid_channel" });
  a.hello(); a.hello("other"); b.hello();
  a.subscribe(); a.subscribe("other", "sub-other"); b.subscribe("c", "sub-b");
  expect(env.read).toHaveBeenCalledTimes(1);
  expect(a.sent).toHaveLength(2); expect(b.sent).toHaveLength(1);
  expect(a.sent[1]).toMatchObject({ target_channel_id: "other", subscription_id: "sub-other", in_reply_to: "sub-other" });
  env.update(1); vi.advanceTimersByTime(200); env.update(2);
  a.subscribe("c", "replacement"); expect(a.sent).toHaveLength(2);
  vi.advanceTimersByTime(300);
  expect(env.read).toHaveBeenCalledTimes(2);
  expect(a.sent.find((frame) => frame.type === "session_status" && frame.subscription_id === "replacement"))
    .toMatchObject({ in_reply_to: "replacement", status: { usage: { input: 2 } } });
  expect(a.sent.findLast((frame) => frame.type === "session_status" && frame.subscription_id === "sub-other"))
    .not.toHaveProperty("in_reply_to");
  env.status.changed(); vi.advanceTimersByTime(500);
  expect(a.sent).toHaveLength(4); expect(b.sent).toHaveLength(2);
  a.subscribe("c", "cached-first");
  expect(a.sent.at(-1)).toMatchObject({ subscription_id: "cached-first", in_reply_to: "cached-first" });
});

test("leaf advancement alone does not push or invalidate ancestor subscription", () => {
  const env = setup(), a = env.owner("a"); a.hello(); a.subscribe();
  env.manager.appendMessage({ role: "user", content: "synthetic", timestamp: 1 });
  env.status.changed(); vi.advanceTimersByTime(500);
  expect(a.sent).toHaveLength(1);
  env.update(1); vi.advanceTimersByTime(500);
  expect(a.sent.at(-1)).toMatchObject({ leaf_id: env.manager.getLeafId(), subscription_id: "sub" });
  expect(a.sent.at(-1)).not.toHaveProperty("in_reply_to");
});

test("ping renews only live validated subscriptions, without computation or resurrection", () => {
  const env = setup(), a = env.owner("a"); a.hello(); a.hello("other"); a.subscribe(); a.subscribe("other", "other-sub");
  vi.advanceTimersByTime(20_000); expect(a.ping()[0]).toMatchObject({ type: "pong" });
  expect(env.read).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(10_001); env.update(1);
  expect(a.sent).toHaveLength(3); expect(a.sent.at(-1)).toMatchObject({ target_channel_id: "c" });
  vi.advanceTimersByTime(SESSION_STATUS_LEASE_MS); a.ping(); env.update(2);
  expect(a.sent).toHaveLength(3);
  expect(env.read).toHaveBeenCalledTimes(2);
});

test.each(["hello", "reset", "scope", "dispose", "invalidate"] as const)("%s cancels pending old subscription", (action) => {
  const env = setup(), a = env.owner("a"), b = env.owner("b");
  a.hello(); b.hello(); a.subscribe(); b.subscribe(); env.update(1);
  if (action === "hello") a.hello();
  if (action === "reset") a.service.reset("branch_changed");
  if (action === "scope") a.service.refreshScope();
  if (action === "dispose") a.service.dispose();
  if (action === "invalidate") env.status.invalidate();
  vi.advanceTimersByTime(500);
  expect(a.sent).toHaveLength(1);
  expect(b.sent).toHaveLength(action === "invalidate" ? 1 : 2);
});

test("failed first delivery is discarded, fresh subscription after window recomputes", () => {
  const env = setup(), a = env.owner("a"); a.hello(); a.send.mockReturnValueOnce(false); a.subscribe();
  env.update(1); vi.advanceTimersByTime(500); expect(env.read).toHaveBeenCalledTimes(1);
  a.subscribe("c", "retry"); expect(env.read).toHaveBeenCalledTimes(2);
  expect(a.sent.at(-1)).toMatchObject({ subscription_id: "retry", in_reply_to: "retry", status: { usage: { input: 1 } } });
});

test("reader exceptions return only fixed error descriptions", () => {
  const env = setup(), a = env.owner("a"); a.hello(); env.read.mockImplementationOnce(() => { throw new Error("private state"); }); a.subscribe();
  expect(a.sent).toEqual([expect.objectContaining({ type: "protocol_error", message: "Session status is unavailable." })]);
  expect(JSON.stringify(a.sent)).not.toContain("private state");
});

function deferred() {
  let resolve!: (snapshot: StatusSnapshot | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<StatusSnapshot | null>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("async reads share one in-flight computation and preserve trailing changes without stale cache reuse", async () => {
  const env = setup(), a = env.owner("a"), b = env.owner("b");
  a.hello(); b.hello(); a.subscribe();
  const pending = deferred();
  env.update(1);
  const captured = env.snapshot();
  env.read.mockReturnValueOnce(pending.promise);
  vi.advanceTimersByTime(500);
  expect(env.read).toHaveBeenCalledTimes(2);
  b.subscribe();
  expect(b.sent).toEqual([]);
  env.update(2);
  vi.advanceTimersByTime(200); env.update(3);
  expect(env.read).toHaveBeenCalledTimes(2);
  pending.resolve(captured); await pending.promise;
  expect(b.sent.at(-1)).toMatchObject({ in_reply_to: "sub", status: { usage: { input: 1 } } });
  expect(env.read).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(299); expect(env.read).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1); expect(env.read).toHaveBeenCalledTimes(3);
  expect(b.sent.at(-1)).toMatchObject({ status: { usage: { input: 3 } } });
  expect(b.sent.at(-1)).not.toHaveProperty("in_reply_to");
  a.subscribe("c", "cached");
  expect(a.sent.at(-1)).toMatchObject({ in_reply_to: "cached", status: { usage: { input: 3 } } });
  expect(env.read).toHaveBeenCalledTimes(3);
});

test("async first responses share one read, preserve correlation and reuse the completed cache", async () => {
  const env = setup(), a = env.owner("a"), b = env.owner("b");
  a.hello(); b.hello();
  const pending = deferred(); env.read.mockReturnValueOnce(pending.promise);
  a.subscribe("c", "first-a"); b.subscribe("c", "first-b");
  expect(env.read).toHaveBeenCalledTimes(1);
  expect(a.sent).toEqual([]); expect(b.sent).toEqual([]);
  pending.resolve(env.snapshot()); await pending.promise;
  expect(a.sent.at(-1)).toMatchObject({ subscription_id: "first-a", in_reply_to: "first-a" });
  expect(b.sent.at(-1)).toMatchObject({ subscription_id: "first-b", in_reply_to: "first-b" });
  a.subscribe("c", "cached");
  expect(a.sent.at(-1)).toMatchObject({ in_reply_to: "cached" });
  expect(env.read).toHaveBeenCalledTimes(1);
  env.status.changed(); vi.advanceTimersByTime(500);
  expect(env.read).toHaveBeenCalledTimes(2);
  expect(a.sent).toHaveLength(2); expect(b.sent).toHaveLength(1);
});

test.each(["resolve", "reject"] as const)("late old generation %s cannot clear a new in-flight computation", async (outcome) => {
  const env = setup(), a = env.owner("a"), b = env.owner("b");
  a.hello(); b.hello();
  const old = deferred(), current = deferred(), oldSnapshot = env.snapshot();
  env.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  a.subscribe();
  env.status.invalidate(); env.update(1);
  const currentSnapshot = env.snapshot();
  a.subscribe("c", "new");
  expect(env.read).toHaveBeenCalledTimes(2);
  if (outcome === "resolve") old.resolve(oldSnapshot);
  else old.reject(new Error("private old failure"));
  await old.promise.catch(() => undefined);
  env.update(2); b.subscribe(); vi.advanceTimersByTime(500);
  expect(env.read).toHaveBeenCalledTimes(2);
  expect(a.sent).toEqual([]); expect(b.sent).toEqual([]);
  current.resolve(currentSnapshot); await current.promise;
  expect(env.read).toHaveBeenCalledTimes(3);
  expect(a.sent).toHaveLength(2);
  expect(a.sent[0]).toMatchObject({ in_reply_to: "new", status: { usage: { input: 1 } } });
  expect(a.sent.at(-1)).toMatchObject({ status: { usage: { input: 2 } } });
  expect(b.sent.at(-1)).toMatchObject({ status: { usage: { input: 2 } } });
});

test.each(["resolve", "reject"] as const)("late old generation %s cannot overwrite the new cache or send errors", async (outcome) => {
  const env = setup(), a = env.owner("a"); a.hello();
  const old = deferred(), oldSnapshot = env.snapshot();
  env.read.mockReturnValueOnce(old.promise); a.subscribe();
  env.status.invalidate(); env.update(1); a.subscribe("c", "new");
  expect(a.sent).toHaveLength(1);
  if (outcome === "resolve") old.resolve(oldSnapshot);
  else old.reject(new Error("private old failure"));
  await old.promise.catch(() => undefined);
  expect(a.sent).toHaveLength(1);
  a.subscribe("c", "cached");
  expect(env.read).toHaveBeenCalledTimes(2);
  expect(a.sent.at(-1)).toMatchObject({ in_reply_to: "cached", status: { usage: { input: 1 } } });
});

test("async reader failures preserve correlated fixed errors and allow a fresh subscription", async () => {
  const env = setup(), a = env.owner("a"); a.hello();
  const pending = deferred(); env.read.mockReturnValueOnce(pending.promise); a.subscribe();
  pending.reject(new Error("private state")); await pending.promise.catch(() => undefined);
  expect(a.sent).toEqual([expect.objectContaining({ type: "protocol_error", in_reply_to: "sub", target_channel_id: "c",
    message: "Session status is unavailable." })]);
  expect(JSON.stringify(a.sent)).not.toContain("private state");
  a.subscribe("c", "retry"); vi.advanceTimersByTime(500);
  expect(a.sent.at(-1)).toMatchObject({ in_reply_to: "retry", type: "session_status" });
});

test.each(["reset", "expire"] as const)("%s of the final async subscriber suppresses late delivery and catch-up", async (action) => {
  const env = setup(), a = env.owner("a"); a.hello();
  const pending = deferred(); env.read.mockReturnValueOnce(pending.promise); a.subscribe();
  env.update(1);
  if (action === "reset") a.service.reset("branch_changed");
  else vi.advanceTimersByTime(SESSION_STATUS_LEASE_MS);
  pending.resolve(env.snapshot()); await pending.promise;
  vi.advanceTimersByTime(1_000);
  expect(a.sent).toEqual([]);
  expect(env.read).toHaveBeenCalledTimes(1);
});
