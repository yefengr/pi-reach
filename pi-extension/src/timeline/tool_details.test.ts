import { createHash } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { ServerFrameSchema, TOOL_DETAIL_LEASE_MS, MAX_TOOL_DETAILS_BYTES, MAX_TOOL_PREVIEW_BYTES,
  MAX_TOOL_DETAILS_QUEUE_BYTES, type ClientFrame, type ServerFrame, type ToolDetailsContent } from "@pi-reach/protocol/session";
import { TimelineRuntime } from "./runtime.js";
import { TimelineV2Service } from "./v2_service.js";
import { ToolDetailStore, previewContent, toolDetailStore, TOOL_DETAIL_UPDATE_INTERVAL_MS } from "./tool_detail_store.js";
import { sessionToolDetails } from "./tool_detail_source.js";
import { PUBLISHED_FILE_TOOL_NAME } from "../files/publications.js";
import { V2PeerChannel } from "../transport/peer_channel.js";
import type { RelayClient } from "../transport/relay_client.js";

const services: TimelineV2Service[] = [];
afterEach(() => { for (const service of services.splice(0)) service.dispose(); vi.useRealTimers(); });
function setup(channel = "c", runtime = new TimelineRuntime(), session = SessionManager.inMemory(process.cwd())) {
  runtime.attach(session);
  const sent: ServerFrame[] = [];
  const service = new TimelineV2Service({ runtime, sessionManager: session, senderRef: "synthetic-owner", extensionVersion: "1.0.0",
    onUserMessage: () => false, onToolDetailFrame: (frame) => { sent.push(frame); return true; } });
  services.push(service);
  service.handle({ protocol_version: 2, type: "session_hello", tool_details: 1, id: "hello", channel_id: channel });
  return { runtime, session, service, sent, channel };
}
function active(env: ReturnType<typeof setup>, tool = "write", args: unknown = { path: "synthetic.txt", content: "synthetic body" }) {
  const message = { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "call", name: tool, arguments: args }], stopReason: "toolUse" };
  env.runtime.onAgentStart();
  const started = env.runtime.onMessageStart(message, env.session)!;
  env.runtime.onMessageUpdate({ type: "message_update", message, assistantMessageEvent: {
    type: "toolcall_end", contentIndex: 0, partial: message, toolCall: message.content[0],
  } } as never, env.session);
  env.runtime.onMessageEnd(message, env.session);
  env.session.appendMessage(message as never);
  env.runtime.onToolExecutionStart({ type: "tool_execution_start", toolCallId: "call", toolName: tool, args } as never, env.session);
  const frame: Extract<ClientFrame, { type: "tool_details_open" }> = { protocol_version: 2, type: "tool_details_open", channel_id: env.channel,
    id: "open", session_id: env.session.getSessionId(), leaf_id: env.session.getLeafId(), group_id: started.groupId,
    tool_ref: { call_entry_id: started.eventId, tool_call_id: "call" } };
  return frame;
}
function decode(frames: ServerFrame[]): ToolDetailsContent {
  const chunks = frames.filter((frame) => frame.type === "tool_details_chunk");
  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) expect(ServerFrameSchema.safeParse(chunk).success).toBe(true);
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data_base64, "base64")));
  expect(chunks.at(-1)).toMatchObject({ final: true, total_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  return JSON.parse(bytes.toString()) as ToolDetailsContent;
}

test("legacy hello requires refresh and cannot become ready or read history", () => {
  const env = setup();
  const legacy = { protocol_version: 2 as const, type: "session_hello" as const, id: "legacy", channel_id: "old" };
  expect(env.service.handle(legacy)).toEqual([expect.objectContaining({ type: "protocol_error", code: "protocol_upgrade_required", in_reply_to: "legacy" })]);
  expect(env.service.handle({ protocol_version: 2, type: "session_sync", id: "sync", channel_id: "old", session_id: env.service.sessionId,
    leaf_id: env.service.leafId, limit: 10 })).toEqual([expect.objectContaining({ type: "protocol_error", code: "invalid_channel" })]);
});

test("zero-prefetch, revision snapshots, close cancellation and native final handoff", () => {
  const env = setup();
  const open = active(env);
  const recover = vi.spyOn(env.runtime, "recover");
  expect(env.sent).toEqual([]);
  env.service.handle(open);
  expect(decode(env.sent)).toMatchObject({ source: "preview", status: "running", limited: true });
  env.sent.length = 0;
  env.runtime.onToolExecutionUpdate({ type: "tool_execution_update", toolCallId: "call", partialResult: { content: [{ type: "text", text: "latest snapshot" }] } } as never, env.session);
  expect(decode(env.sent)).toMatchObject({ result: [{ type: "text", text: "latest snapshot" }] });
  expect(env.sent[0]).toMatchObject({ revision: 2, in_reply_to: "open" });
  expect(recover).not.toHaveBeenCalled();
  env.sent.length = 0;
  // A close for another channel/request cannot remove this subscription.
  env.service.handle({ protocol_version: 2, type: "tool_details_close", channel_id: "c", id: "close-other", subscription_id: "different",
    session_id: open.session_id, leaf_id: open.leaf_id });
  const result = { role: "toolResult", toolCallId: "call", toolName: "write", content: [{ type: "text", text: "saved original" }], isError: false, timestamp: 2 };
  env.runtime.onMessageStart(result, env.session);
  env.session.appendMessage(result as never);
  env.runtime.onMessageEnd(result, env.session);
  env.runtime.onTurnEnd(env.session);
  expect(decode(env.sent)).toMatchObject({ source: "session", result: result.content, limited: false });
  expect(recover).toHaveBeenCalled();
  expect(toolDetailStore.stats.subscriptions).toBe(0);
  env.sent.length = 0;
  env.service.handle({ ...open, id: "again" });
  expect(decode(env.sent)).toMatchObject({ source: "session" });
});

test("preparing details avoid history projection and yield to native completion without execution-start", () => {
  const env = setup();
  const message = { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "synthetic.txt" } }] };
  env.runtime.onAgentStart();
  const started = env.runtime.onMessageStart(message, env.session)!;
  const recover = vi.spyOn(env.runtime, "recover");
  env.runtime.onMessageUpdate({ type: "message_update", message, assistantMessageEvent: {
    type: "toolcall_delta", contentIndex: 0, partial: message, delta: '{"path":"synthetic.txt"}',
  } } as never, env.session);
  const details = env.runtime.details({ call_entry_id: started.eventId, tool_call_id: "call" }, started.groupId);
  expect(details).toMatchObject({ content: { source: "preview", status: "preparing", args: { path: "synthetic.txt" } } });
  expect(recover).not.toHaveBeenCalled();
  env.runtime.onMessageEnd(message, env.session);
  env.session.appendMessage(message as never);
  const result = { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "synthetic saved result" }], isError: false, timestamp: 2 };
  env.runtime.onMessageStart(result, env.session);
  env.session.appendMessage(result as never);
  env.runtime.onMessageEnd(result, env.session);
  env.runtime.onTurnEnd(env.session);
  expect(env.runtime.details({ call_entry_id: started.eventId, tool_call_id: "call" }, started.groupId))
    .toMatchObject({ content: { source: "session", limited: false, result: result.content } });
});

test("late native publication for an old ref keeps the new same-ID preparation open", () => {
  vi.useFakeTimers();
  const env = setup();
  const old = active(env);
  const result = { role: "toolResult", toolCallId: "call", toolName: "write", content: [{ type: "text", text: "synthetic old result" }], isError: false, timestamp: 2 };
  env.runtime.onMessageStart(result, env.session);
  env.session.appendMessage(result as never);
  env.runtime.onMessageEnd(result, env.session);
  const message = { role: "assistant", timestamp: 3, content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "next-synthetic.txt" } }] };
  const started = env.runtime.onMessageStart(message, env.session)!;
  env.runtime.onMessageUpdate({ type: "message_update", message, assistantMessageEvent: {
    type: "toolcall_delta", contentIndex: 0, partial: message, delta: '{"path":"next-synthetic.txt"}',
  } } as never, env.session);
  expect(started.eventId).not.toBe(old.tool_ref.call_entry_id);
  // 旧轮正式发布晚于新轮准备；不能按共享 call ID 关闭新轮槽位。
  env.runtime.onTurnEnd(env.session);
  const toolRef = { call_entry_id: started.eventId, tool_call_id: "call" };
  env.service.handle({ ...old, id: "new-same-id", leaf_id: env.session.getLeafId(), group_id: started.groupId, tool_ref: toolRef });
  expect(decode(env.sent)).toMatchObject({ source: "preview", status: "preparing", tool_ref: toolRef, args: { path: "next-synthetic.txt" } });
});

test("rapid output coalesces to the latest viewed snapshot without repeating unchanged summaries", () => {
  vi.useFakeTimers();
  const partials: unknown[] = [];
  const env = setup("c", new TimelineRuntime({ onPartial: (partial) => partials.push(partial) }));
  const open = active(env);
  env.service.handle(open);
  env.sent.length = 0;
  const before = partials.length;
  const update = (text: string) => env.runtime.onToolExecutionUpdate({ type: "tool_execution_update", toolCallId: "call",
    partialResult: { content: [{ type: "text", text }] } } as never, env.session);
  update("first");
  expect(decode(env.sent)).toMatchObject({ result: [{ type: "text", text: "first" }] });
  env.sent.length = 0;
  update("second");
  update("latest");
  expect(env.sent).toEqual([]);
  expect(partials.length - before).toBe(1);
  vi.advanceTimersByTime(TOOL_DETAIL_UPDATE_INTERVAL_MS);
  expect(decode(env.sent)).toMatchObject({ result: [{ type: "text", text: "latest" }] });
  env.sent.length = 0;
  update("pending at close");
  env.service.handle({ protocol_version: 2, type: "tool_details_close", channel_id: "c", id: "close-pending", subscription_id: open.id,
    session_id: open.session_id, leaf_id: open.leaf_id });
  vi.advanceTimersByTime(TOOL_DETAIL_UPDATE_INTERVAL_MS);
  expect(env.sent).toEqual([]);
});

test("close, replacement selection, scope reset, detach and lease release subscriptions", () => {
  vi.useFakeTimers();
  const env = setup();
  const open = active(env);
  env.service.handle(open);
  env.service.handle({ ...open, id: "new-selection" });
  expect(toolDetailStore.stats.subscriptions).toBe(1);
  env.service.handle({ protocol_version: 2, type: "tool_details_close", channel_id: "c", id: "close", subscription_id: "new-selection", session_id: open.session_id, leaf_id: open.leaf_id });
  expect(toolDetailStore.stats.subscriptions).toBe(0);
  env.service.handle(open);
  vi.advanceTimersByTime(TOOL_DETAIL_LEASE_MS - 1000);
  env.service.handle({ protocol_version: 2, type: "ping", id: "keepalive", channel_id: "c", session_id: open.session_id, leaf_id: open.leaf_id });
  vi.advanceTimersByTime(1000);
  expect(toolDetailStore.stats.subscriptions).toBe(1);
  vi.advanceTimersByTime(TOOL_DETAIL_LEASE_MS);
  expect(toolDetailStore.stats.subscriptions).toBe(0);
  env.service.handle(open);
  env.service.refreshScope();
  expect(toolDetailStore.stats.subscriptions).toBe(0);
  env.service.handle({ protocol_version: 2, type: "session_hello", tool_details: 1, id: "hello-again", channel_id: "c" });
  env.service.handle(open);
  env.service.dispose();
  expect(toolDetailStore.stats.subscriptions).toBe(0);
});

test("summary fanout targets only negotiated channels, not legacy peers sharing an Owner", () => {
  const env = setup();
  env.service.handle({ protocol_version: 2, type: "session_hello", id: "old", channel_id: "legacy" });
  const open = active(env);
  env.service.handle({ protocol_version: 2, type: "session_hello", tool_details: 1, id: "second", channel_id: "second" });
  const partial = { protocol_version: 2 as const, type: "timeline_partial" as const, session_id: env.service.sessionId,
    leaf_id: env.service.leafId, group_id: open.group_id, partial_id: "partial", kind: "tool" as const, status: "running" as const,
    tool: "write", tool_call_id: "call", representation: "summary" as const, summary: { action: "write" as const }, tool_ref: open.tool_ref };
  expect(env.service.partialFrames(partial).map((frame) => "target_channel_id" in frame && frame.target_channel_id)).toEqual(["c", "second"]);
  const event = { event_id: "event", event_seq: 1, timestamp: 1, session_id: env.service.sessionId, leaf_id: env.service.leafId,
    group_id: open.group_id, kind: "tool" as const, status: "complete" as const, tool: "write", tool_call_id: "call",
    representation: "summary" as const, summary: { action: "write" as const }, tool_ref: open.tool_ref };
  expect(env.service.publishFrames(event).map((frame) => "target_channel_id" in frame && frame.target_channel_id)).toEqual(["c", "second"]);
});

test("preview store limits are global, prefer unwatched victims and exclude image payloads", () => {
  const store = new ToolDetailStore();
  const content = previewContent({ tool_ref: { call_entry_id: "a", tool_call_id: "b" }, tool: "write", status: "running" },
    { content: "x".repeat(1000000) }, [{ type: "image", get data(): never { throw new Error("image data read"); } }]);
  store.put("watched", content);
  const unwatch = store.watch("watched", () => {});
  for (let i = 0; i < 30; i += 1) store.put(`synthetic-${i}`, content);
  expect(store.get("watched")).toBeDefined();
  expect(store.stats.count).toBe(8);
  expect(store.stats.bytes).toBeLessThanOrEqual(512 * 1024);
  expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThanOrEqual(MAX_TOOL_PREVIEW_BYTES);
  unwatch();
  const tokens = Array.from({ length: 17 }, () => ({}));
  expect(tokens.map((token) => store.acquire(token))).toEqual([...Array<boolean>(16).fill(true), false]);
  for (const token of tokens) store.release(token);
});

test.each([
  ["per-string limit", "x".repeat(4095) + "😀tail", "x".repeat(4095)],
  ["shared character budget", { a: "a".repeat(3998), b: "b".repeat(3999) + "😀tail" }, { a: "a".repeat(3998), b: "b".repeat(3999) }],
])("preview truncation preserves complete surrogate pairs at the %s", (_name, args, expected) => {
  const content = previewContent({ tool_ref: { call_entry_id: "synthetic-entry", tool_call_id: "synthetic-call" }, tool: "synthetic_echo", status: "running" }, args);
  expect(content.args).toEqual(expected);
});

test("native references isolate reused call IDs and reject huge final content before encoding", () => {
  const session = SessionManager.inMemory(process.cwd());
  const refs = [];
  for (const content of ["first", "second"]) {
    const entry = session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "same", name: "write", arguments: { content } }], timestamp: 1 } as never);
    refs.push({ call_entry_id: entry, tool_call_id: "same" });
    session.appendMessage({ role: "toolResult", toolCallId: "same", toolName: "write", content: [{ type: "text", text: content }], timestamp: 2, isError: false } as never);
  }
  expect(sessionToolDetails(session, refs[0]!)).toMatchObject({ content: { args: { content: "first" }, result: [{ type: "text", text: "first" }] } });
  expect(sessionToolDetails(session, refs[1]!)).toMatchObject({ content: { args: { content: "second" } } });
  const entry = session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "huge", name: "read", arguments: {} }], timestamp: 3 } as never);
  session.appendMessage({ role: "toolResult", toolCallId: "huge", toolName: "read", content: [{ type: "text", text: "x".repeat(MAX_TOOL_DETAILS_BYTES + 1) }], timestamp: 4, isError: false } as never);
  expect(sessionToolDetails(session, { call_entry_id: entry, tool_call_id: "huge" })).toEqual({ code: "too_large", terminal: true });
});

test("publish_file hides local source path in both preview and session details", () => {
  const env = setup();
  const path = "/isolated-synthetic/private-source.txt";
  const open = active(env, PUBLISHED_FILE_TOOL_NAME, { path });
  env.service.handle(open);
  expect(JSON.stringify(decode(env.sent))).not.toContain(path);
  env.sent.length = 0;
  const result = { role: "toolResult", toolCallId: "call", toolName: PUBLISHED_FILE_TOOL_NAME, content: [{ type: "text", text: "published synthetic reference" }], timestamp: 2, isError: false };
  env.runtime.onMessageStart(result, env.session);
  env.session.appendMessage(result as never);
  env.runtime.onMessageEnd(result, env.session);
  env.runtime.onTurnEnd(env.session);
  expect(decode(env.sent)).toMatchObject({ args: {}, source: "session" });
  expect(JSON.stringify(decode(env.sent))).not.toContain(path);
});

test("all Owners share sixteen subscriptions and eviction does not break final handoff", () => {
  const env = setup();
  const open = active(env);
  for (let i = 0; i < 16; i += 1) {
    const other = setup(`channel-${i}`, env.runtime, env.session);
    other.service.handle({ ...open, channel_id: other.channel, id: `open-${i}` });
    expect(other.sent[0]?.type).toBe("tool_details_chunk");
  }
  expect(toolDetailStore.stats.subscriptions).toBe(16);
  expect(env.service.handle(open)).toEqual([expect.objectContaining({ type: "tool_details_error", code: "busy", terminal: true, retryable: true })]);
  expect(toolDetailStore.stats.subscriptions).toBe(16);
  for (const service of services) service.dispose();
  env.service.handle({ protocol_version: 2, type: "session_hello", tool_details: 1, id: "hello-reopen", channel_id: env.channel });
  env.service.handle(open);
  env.sent.length = 0;
  toolDetailStore.remove(env.runtime.detailKey(open.tool_ref));
  expect(env.sent).toEqual([expect.objectContaining({ type: "tool_details_error", code: "unavailable", terminal: false })]);
  expect(toolDetailStore.stats.subscriptions).toBe(1);
  env.sent.length = 0;
  env.runtime.onAgentEnd([]);
  expect(env.sent).toEqual([expect.objectContaining({ type: "tool_details_error", terminal: true })]);
  expect(toolDetailStore.stats.subscriptions).toBe(0);
});

test("foreign group/reference errors remain scoped and do not affect chat readiness", () => {
  const env = setup();
  const open = active(env);
  env.service.handle({ ...open, group_id: "wrong-group" });
  expect(env.sent).toEqual([expect.objectContaining({ type: "tool_details_error", code: "not_found", terminal: true, target_channel_id: "c", in_reply_to: "open" })]);
  expect(env.service.handle({ protocol_version: 2, type: "ping", channel_id: "c", id: "chat-still-ready", session_id: open.session_id, leaf_id: open.leaf_id }))
    .toEqual([expect.objectContaining({ type: "pong", in_reply_to: "chat-still-ready" })]);
  expect(env.sent.some((frame) => frame.type === "protocol_error")).toBe(false);
});

test("detail WS budget rejects only detail chunks, leaving ordinary output live", () => {
  const relay = { bufferedAmount: MAX_TOOL_DETAILS_QUEUE_BYTES, send: vi.fn(), on: vi.fn(), off: vi.fn() };
  const peer = new V2PeerChannel(relay as unknown as RelayClient, "owner", { deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime" }, () => {});
  expect(peer.sendV2({ protocol_version: 2, type: "tool_details_chunk", target_channel_id: "c", in_reply_to: "open", session_id: "s", leaf_id: null,
    group_id: "g", tool_ref: { call_entry_id: "a", tool_call_id: "b" }, revision: 1, index: 0, data_base64: "e30=", final: true,
    total_bytes: 2, sha256: createHash("sha256").update("{}").digest("hex") })).toBe(false);
  expect(relay.send).not.toHaveBeenCalled();
  expect(peer.sendV2({ protocol_version: 2, type: "pong", target_channel_id: "c", in_reply_to: "ping" })).toBe(true);
  expect(relay.send).toHaveBeenCalledOnce();
});
