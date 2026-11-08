import { MAX_FRAGMENT_BYTES, MAX_TOOL_DETAILS_BYTES, MAX_TOOL_PREVIEW_BYTES, TOOL_DETAIL_KEEPALIVE_MS, toolDetailsContentSchema, canonicalBase64ByteLength, type ClientFrame, type ServerFrame, type ToolDetailsContent, type ToolRef } from "@pi-reach/protocol/session";
import { decodeBase64 } from "../pi-reach/encoding";
import { toolDetailsCacheKey, type ToolDetailsCache, type ToolDetailsCacheScope } from "./tool-details-cache";

export type ToolDetailsTarget = { groupId: string; toolRef: ToolRef; tool: string };
export type ToolDetailsConnection = { channelId: string; sessionId: string; leafId: string | null; runtimeInstanceId: string; send: (frame: ClientFrame) => boolean };
export type ToolDetailsState = { key?: string; phase: "idle" | "loading" | "ready" | "error"; content?: ToolDetailsContent; error?: "offline" | "unavailable" | "invalid" | "too_large" | "not_found" | "busy" | "cancelled"; retryable?: boolean };
type Selection = { token: object; id: string; key: string; scope: ToolDetailsCacheScope; target: ToolDetailsTarget; connection: ToolDetailsConnection | null; revision: number; nextIndex: number; bytes: number; chunks: Uint8Array[]; ended: boolean; timer?: ReturnType<typeof setInterval> };
const sameRef = (a: ToolRef, b: ToolRef) => a.call_entry_id === b.call_entry_id && a.tool_call_id === b.tool_call_id;
const TOOL_DETAILS_ID_PREFIX = "tool-details:";

/** 只有显式阅读选择才创建订阅。详情错误与聊天恢复、发送门禁完全分离。 */
export class ToolDetailsController {
  private selection: Selection | null = null;
  private state: ToolDetailsState = { phase: "idle" };
  private listeners = new Set<() => void>();
  constructor(private readonly cache: ToolDetailsCache, private readonly makeId: () => string = () => crypto.randomUUID()) {}
  getSnapshot = (): ToolDetailsState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: ToolDetailsState): void {
    this.state = { ...state, key: this.selection?.key };
    for (const listener of this.listeners) listener();
  }
  async open(scope: ToolDetailsCacheScope, target: ToolDetailsTarget, connection: ToolDetailsConnection | null, key = toolDetailsCacheKey(scope, target.groupId, target.toolRef)): Promise<void> {
    this.cancel();
    const current: Selection = { token: {}, id: `${TOOL_DETAILS_ID_PREFIX}${this.makeId()}`, key, scope, target, connection, revision: 0, nextIndex: 0, bytes: 0, chunks: [], ended: false };
    this.selection = current;
    this.publish({ phase: "loading" });
    try {
      const content = await this.cache.get(toolDetailsCacheKey(scope, target.groupId, target.toolRef));
      if (this.selection !== current) return;
      if (content && sameRef(content.tool_ref, target.toolRef) && content.tool === target.tool) {
        current.ended = true; this.publish({ phase: "ready", content }); return;
      }
    } catch { /* 可回收缓存故障不影响远端阅读。 */ }
    if (this.selection !== current) return;
    if (!connection || connection.sessionId !== scope.sessionId) { this.publish({ phase: "error", error: "offline" }); return; }
    const request: ClientFrame = { protocol_version: 2, type: "tool_details_open", id: current.id, channel_id: connection.channelId, session_id: connection.sessionId, leaf_id: connection.leafId, group_id: target.groupId, tool_ref: target.toolRef };
    if (!connection.send(request)) { this.fail(current, "unavailable"); return; }
    if (this.selection !== current || current.ended) return;
    current.timer = setInterval(() => {
      if (this.selection !== current || current.ended) return;
      if (!connection.send({ protocol_version: 2, type: "ping", id: `${current.id}:${this.makeId()}`, channel_id: connection.channelId, session_id: connection.sessionId, leaf_id: connection.leafId })) this.fail(current, "unavailable");
    }, TOOL_DETAIL_KEEPALIVE_MS);
  }
  cancel = (): void => {
    const current = this.selection;
    this.selection = null;
    if (current) {
      this.stop(current);
      if (current.connection && !current.ended) current.connection.send({ protocol_version: 2, type: "tool_details_close", id: `${current.id}:${this.makeId()}`, channel_id: current.connection.channelId, session_id: current.connection.sessionId, leaf_id: current.connection.leafId, subscription_id: current.id });
      current.chunks = [];
    }
    this.publish({ phase: "idle" });
  };
  disconnect = (): void => { this.cancel(); };
  private stop(current: Selection): void { if (current.timer) clearInterval(current.timer); current.timer = undefined; }
  private fail(current: Selection, error: ToolDetailsState["error"], retryable = false): void {
    if (this.selection !== current) return;
    this.stop(current); current.chunks = []; current.ended = true;
    if (current.connection) current.connection.send({ protocol_version: 2, type: "tool_details_close", id: `${current.id}:${this.makeId()}`, channel_id: current.connection.channelId, session_id: current.connection.sessionId, leaf_id: current.connection.leafId, subscription_id: current.id });
    this.publish({ phase: "error", error, retryable });
  }
  receive(frame: ServerFrame): boolean {
    const current = this.selection;
    const connection = current?.connection;
    // 原生门禁也可能回通用 protocol_error。详情及其迟到关闭/续租响应不能进入聊天错误路径。
    if ((frame.type === "protocol_error" || frame.type === "pong") && frame.in_reply_to?.startsWith(TOOL_DETAILS_ID_PREFIX)) {
      if (frame.type === "protocol_error" && current && connection && !current.ended
        && (!("target_channel_id" in frame) || frame.target_channel_id === connection.channelId)
        && (frame.in_reply_to === current.id || frame.in_reply_to.startsWith(`${current.id}:`))) this.fail(current, "unavailable", true);
      return true;
    }
    if (frame.type !== "tool_details_chunk" && frame.type !== "tool_details_error") return false;
    if (!current || !connection || current.ended || frame.in_reply_to !== current.id || frame.target_channel_id !== connection.channelId || frame.session_id !== connection.sessionId || frame.leaf_id !== connection.leafId || frame.group_id !== current.target.groupId || !sameRef(frame.tool_ref, current.target.toolRef) || frame.revision < current.revision) return true;
    if (frame.revision > current.revision) { current.revision = frame.revision; current.chunks = []; current.bytes = 0; current.nextIndex = 0; }
    if (frame.type === "tool_details_error") {
      if (frame.terminal) this.fail(current, frame.code, frame.retryable);
      else { current.chunks = []; current.bytes = 0; current.nextIndex = 0; this.publish({ ...this.state, phase: "loading", error: frame.code, retryable: frame.retryable }); }
      return true;
    }
    const length = canonicalBase64ByteLength(frame.data_base64);
    if (frame.index !== current.nextIndex || length === null || length > MAX_FRAGMENT_BYTES || current.bytes + length > MAX_TOOL_DETAILS_BYTES) { this.fail(current, "invalid"); return true; }
    const bytes = decodeBase64(frame.data_base64);
    current.nextIndex += 1; current.bytes += bytes.length; current.chunks.push(bytes);
    if (frame.final) {
      const revision = current.revision;
      const chunks = current.chunks;
      current.chunks = [];
      if (current.bytes !== frame.total_bytes) this.fail(current, "invalid");
      else void this.complete(current, revision, chunks, frame.total_bytes, frame.sha256);
    }
    return true;
  }
  private async complete(current: Selection, revision: number, chunks: Uint8Array[], size: number, sha256: string): Promise<void> {
    try {
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      if (this.selection !== current || revision !== current.revision || current.ended) return;
      if (Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") !== sha256) throw new Error("digest");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const content = toolDetailsContentSchema.parse(JSON.parse(text));
      if (!sameRef(content.tool_ref, current.target.toolRef) || content.tool !== current.target.tool || content.source === "preview" && size > MAX_TOOL_PREVIEW_BYTES) throw new Error("identity");
      if (content.source === "session") { current.ended = true; this.stop(current); }
      this.publish({ phase: "ready", content });
      if (content.source === "session") void this.cache.put(current.scope, current.target.groupId, current.target.toolRef, text).catch(() => {});
    } catch { if (revision === current.revision) this.fail(current, "invalid"); }
  }
}
