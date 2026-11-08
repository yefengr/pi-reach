import { afterEach, expect, test, vi } from "vitest";
import { MAX_FRAGMENT_BYTES, MAX_TOOL_DETAILS_BYTES, TOOL_DETAIL_KEEPALIVE_MS, type ClientFrame, type ServerFrame, type ToolDetailsContent } from "@pi-reach/protocol/session";
import { ToolDetailsController, type ToolDetailsTarget } from "./tool-details";
import { toolDetailsCacheKey, type ToolDetailsCache } from "./tool-details-cache";

// 全部为隔离合成文档，不读取真实会话。
const scope = { ownerId: "synthetic-owner", deviceId: "device", endpointId: "endpoint", sessionId: "session" };
const target: ToolDetailsTarget = { groupId: "group", toolRef: { call_entry_id: "assistant-entry", tool_call_id: "call" }, tool: "read" };
const final: ToolDetailsContent = { tool_ref: target.toolRef, tool: "read", source: "session", status: "complete", args: { path: "synthetic.txt" }, result: [{ type: "text", text: "合成结果" }], limited: false };
const controllers: ToolDetailsController[] = [];
function setup(cache: ToolDetailsCache = { get: vi.fn(async () => undefined), put: vi.fn(async () => {}) }) {
  let counter = 0;
  const frames: ClientFrame[] = [];
  const controller = new ToolDetailsController(cache, () => `request-${++counter}`);
  controllers.push(controller);
  const connection = { channelId: "channel", sessionId: "session", runtimeInstanceId: "runtime", leafId: "open-leaf", send: (frame: ClientFrame) => { frames.push(frame); return true; } };
  return { controller, cache, frames, connection };
}
async function chunks(content: ToolDetailsContent, revision = 1, id = "tool-details:request-1", bytes = new TextEncoder().encode(JSON.stringify(content))): Promise<Extract<ServerFrame, { type: "tool_details_chunk" }>[]> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  const pieces: Extract<ServerFrame, { type: "tool_details_chunk" }>[] = [];
  for (let start = 0; start < bytes.length; start += MAX_FRAGMENT_BYTES) {
    const data = Buffer.from(bytes.subarray(start, start + MAX_FRAGMENT_BYTES)).toString("base64");
    const base = { protocol_version: 2 as const, type: "tool_details_chunk" as const, target_channel_id: "channel", in_reply_to: id, session_id: "session", leaf_id: "open-leaf", group_id: "group", tool_ref: content.tool_ref, revision, index: pieces.length, data_base64: data };
    pieces.push(start + MAX_FRAGMENT_BYTES >= bytes.length ? { ...base, final: true, total_bytes: bytes.length, sha256 } : { ...base, final: false });
  }
  return pieces;
}
afterEach(() => { controllers.splice(0).forEach(controller => controller.cancel()); vi.useRealTimers(); });

test("idle creates no prefetch; only explicit selection opens a subscription", async () => {
  const { controller, frames, connection } = setup();
  expect(frames).toEqual([]);
  await controller.open(scope, target, connection);
  expect(frames).toEqual([expect.objectContaining({ type: "tool_details_open", tool_ref: target.toolRef })]);
  controller.cancel();
  expect(frames.at(-1)).toMatchObject({ type: "tool_details_close", subscription_id: "tool-details:request-1" });
});
test("validates a complete snapshot atomically and caches only native final results", async () => {
  const { controller, frames, connection, cache } = setup();
  await controller.open(scope, target, connection);
  const preview: ToolDetailsContent = { ...final, source: "preview", status: "running", limited: true };
  for (const frame of await chunks(preview)) controller.receive(frame);
  await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({ phase: "ready", content: preview }));
  expect(cache.put).not.toHaveBeenCalled();
  for (const frame of await chunks(final, 2)) controller.receive(frame);
  await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({ phase: "ready", content: final }));
  expect(cache.put).toHaveBeenCalledOnce();
  expect(frames.filter(frame => frame.type === "tool_details_open")).toHaveLength(1);
});
test("rejects late selection, wrong channel, branch and native call references", async () => {
  const { controller, connection } = setup();
  await controller.open(scope, target, connection);
  const [frame] = await chunks(final);
  for (const changed of [{ target_channel_id: "other" }, { leaf_id: "other" }, { tool_ref: { ...target.toolRef, call_entry_id: "other" } }, { group_id: "other" }]) controller.receive({ ...frame, ...changed });
  expect(controller.getSnapshot().phase).toBe("loading");
  controller.cancel();
  await controller.open(scope, { ...target, toolRef: { ...target.toolRef, call_entry_id: "new-entry" } }, connection);
  controller.receive(frame);
  expect(controller.getSnapshot().phase).toBe("loading");
});
test("new revisions replace incomplete assemblies and stale digests cannot publish", async () => {
  const { controller, connection } = setup();
  await controller.open(scope, target, connection);
  const large = await chunks({ ...final, result: "a".repeat(MAX_FRAGMENT_BYTES * 2) });
  controller.receive(large[0]);
  const replacement = await chunks(final, 2);
  replacement.forEach(frame => controller.receive(frame));
  large.slice(1).forEach(frame => controller.receive(frame));
  await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({ phase: "ready", content: final }));
});
test.each(["digest", "order", "size", "utf8", "schema"])("fails closed for invalid %s without publishing content", async (failure) => {
  const { controller, connection, cache } = setup();
  await controller.open(scope, target, connection);
  const bytes = failure === "utf8" ? new Uint8Array([0xff]) : failure === "schema" ? new TextEncoder().encode('{}') : undefined;
  const [valid] = await chunks(final, 1, "tool-details:request-1", bytes);
  const frame = { ...valid, ...(failure === "digest" ? { sha256: "0".repeat(64) } : {}), ...(failure === "order" ? { index: 2 } : {}), ...(failure === "size" ? { total_bytes: 1 } : {}) };
  controller.receive(frame);
  await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({ phase: "error", error: "invalid" }));
  expect(cache.put).not.toHaveBeenCalled();
});
test("enforces fragment and total document budgets before assembly", async () => {
  const { controller, connection } = setup();
  await controller.open(scope, target, connection);
  const [frame] = await chunks(final);
  controller.receive({ ...frame, data_base64: Buffer.alloc(MAX_FRAGMENT_BYTES + 1).toString("base64") });
  expect(controller.getSnapshot().phase).toBe("error");
  await controller.open(scope, target, connection);
  const id = "tool-details:request-3";
  const data_base64 = Buffer.alloc(MAX_FRAGMENT_BYTES).toString("base64");
  for (let index = 0; index <= Math.floor(MAX_TOOL_DETAILS_BYTES / MAX_FRAGMENT_BYTES); index += 1) controller.receive({ ...frame, in_reply_to: id, final: false, data_base64, index });
  expect(controller.getSnapshot().phase).toBe("error");
});
test("lease ping runs only while watching, including a reclaimed preview", async () => {
  vi.useFakeTimers();
  const { controller, frames, connection } = setup();
  await controller.open(scope, target, connection);
  controller.receive({ protocol_version: 2, type: "tool_details_error", target_channel_id: "channel", in_reply_to: "tool-details:request-1", session_id: "session", leaf_id: "open-leaf", group_id: "group", tool_ref: target.toolRef, revision: 1, code: "unavailable", terminal: false, retryable: true });
  vi.advanceTimersByTime(TOOL_DETAIL_KEEPALIVE_MS);
  expect(frames.at(-1)?.type).toBe("ping");
  controller.disconnect();
  const count = frames.length;
  vi.advanceTimersByTime(TOOL_DETAIL_KEEPALIVE_MS * 3);
  expect(frames).toHaveLength(count);
});
test("read-only selection uses final cache but never opens a remote channel", async () => {
  const cached = setup({ get: vi.fn(async () => final), put: vi.fn(async () => {}) });
  await cached.controller.open(scope, target, null);
  expect(cached.controller.getSnapshot()).toMatchObject({ phase: "ready", content: final });
  expect(cached.frames).toEqual([]);
  const missing = setup();
  await missing.controller.open(scope, target, null);
  expect(missing.controller.getSnapshot()).toMatchObject({ phase: "error", error: "offline" });
  expect(missing.frames).toEqual([]);
});
test("closing during cache lookup suppresses both remote open and late cached content", async () => {
  let resolve!: (value: ToolDetailsContent) => void;
  const cache = { get: () => new Promise<ToolDetailsContent>(done => { resolve = done; }), put: vi.fn(async () => {}) };
  const { controller, connection, frames } = setup(cache);
  const opening = controller.open(scope, target, connection);
  controller.cancel(); resolve(final); await opening;
  expect(controller.getSnapshot().phase).toBe("idle");
  expect(frames.some(frame => frame.type === "tool_details_open")).toBe(false);
});
test("persistent cache identity isolates owner/device/endpoint/session/group/native entry but not runtime", () => {
  const key = toolDetailsCacheKey(scope, target.groupId, target.toolRef);
  for (const property of ["ownerId", "deviceId", "endpointId", "sessionId"] as const) expect(toolDetailsCacheKey({ ...scope, [property]: "other" }, target.groupId, target.toolRef)).not.toBe(key);
  expect(toolDetailsCacheKey(scope, "other", target.toolRef)).not.toBe(key);
  expect(toolDetailsCacheKey(scope, target.groupId, { ...target.toolRef, call_entry_id: "other" })).not.toBe(key);
});

const detailProtocolError = (requestId: string): ServerFrame => ({ protocol_version: 2, type: "protocol_error",
  target_channel_id: "channel", in_reply_to: requestId, code: "internal_error", message: "SYNTHETIC_SERVER_MESSAGE" });
test("generic detail errors and late close replies stay isolated from chat routing", async () => {
  const { controller, frames, connection } = setup();
  await controller.open(scope, target, connection);
  const first = frames[0];
  expect(controller.receive(detailProtocolError(first.id))).toBe(true);
  expect(controller.getSnapshot()).toMatchObject({ phase: "error", error: "unavailable", retryable: true });
  const closing = frames.at(-1)!;
  await controller.open(scope, { ...target, toolRef: { ...target.toolRef, call_entry_id: "new-entry" } }, connection);
  const selected = controller.getSnapshot();
  expect(controller.receive(detailProtocolError(first.id))).toBe(true);
  expect(controller.receive(detailProtocolError(closing.id))).toBe(true);
  expect(controller.getSnapshot()).toBe(selected);
  expect(controller.receive(detailProtocolError("ordinary-chat-request"))).toBe(false);
  controller.cancel();
  expect(controller.receive(detailProtocolError(first.id))).toBe(true);
  expect(controller.getSnapshot().phase).toBe("idle");
});
test("detail keepalive replies remain scoped to their reading selection", async () => {
  vi.useFakeTimers();
  const { controller, frames, connection } = setup();
  await controller.open(scope, target, connection);
  vi.advanceTimersByTime(TOOL_DETAIL_KEEPALIVE_MS);
  const ping = frames.at(-1)!;
  expect(ping.type).toBe("ping");
  const before = controller.getSnapshot();
  expect(controller.receive({ protocol_version: 2, type: "pong", target_channel_id: "channel", in_reply_to: ping.id })).toBe(true);
  expect(controller.getSnapshot()).toBe(before);
  expect(controller.receive(detailProtocolError(ping.id))).toBe(true);
  expect(controller.getSnapshot()).toMatchObject({ phase: "error", error: "unavailable", retryable: true });
});
