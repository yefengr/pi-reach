import { createHash } from "node:crypto";
import { MAX_FRAGMENT_BYTES, TOOL_DETAIL_LEASE_MS, type ClientFrame, type ServerFrame } from "@pi-reach/protocol/session";
import type { TimelineRuntime } from "./runtime.js";
import { toolDetailStore } from "./tool_detail_store.js";

type Open = Extract<ClientFrame, { type: "tool_details_open" }>;
type ErrorCode = Extract<ServerFrame, { type: "tool_details_error" }>["code"];
type Subscription = { request: Open; revision: number; unwatch: () => void; timer: ReturnType<typeof setTimeout> | null };

/** 详情独立于正式发布/发送门禁；每次更新都是完整替换快照。 */
export class ToolDetailService {
  private readonly subscriptions = new Map<string, Subscription>();
  constructor(private readonly runtime: TimelineRuntime,
    private readonly valid: (frame: Open) => boolean,
    private readonly send?: (frame: ServerFrame) => boolean) {}

  open(request: Open): ServerFrame[] {
    this.closeChannel(request.channel_id);
    const subscription: Subscription = { request, revision: 0, unwatch: () => {}, timer: null };
    if (!toolDetailStore.acquire(subscription)) return [this.error(subscription, "busy", true, true)];
    this.subscriptions.set(request.channel_id, subscription);
    subscription.unwatch = toolDetailStore.watch(this.runtime.detailKey(request.tool_ref), () => this.deliver(subscription, this.snapshot(subscription)));
    this.renew(request.channel_id);
    const frames = this.snapshot(subscription);
    if (!this.send) return frames;
    this.deliver(subscription, frames);
    return [];
  }

  private deliver(subscription: Subscription, frames: ServerFrame[]): void {
    if (!this.send) return;
    for (const frame of frames) {
      if (this.send(frame)) continue;
      this.send(this.error(subscription, "busy", true, true));
      this.closeChannel(subscription.request.channel_id);
      break;
    }
  }

  close(channelId: string, id: string): void {
    if (this.subscriptions.get(channelId)?.request.id === id) this.closeChannel(channelId);
  }
  closeChannel(channelId: string): void {
    const subscription = this.subscriptions.get(channelId);
    if (!subscription) return;
    this.subscriptions.delete(channelId);
    if (subscription.timer) clearTimeout(subscription.timer);
    subscription.unwatch();
    toolDetailStore.release(subscription);
  }
  dispose(): void { for (const channelId of this.subscriptions.keys()) this.closeChannel(channelId); }
  renew(channelId: string): void {
    const subscription = this.subscriptions.get(channelId);
    if (!subscription) return;
    if (subscription.timer) clearTimeout(subscription.timer);
    subscription.timer = setTimeout(() => this.closeChannel(channelId), TOOL_DETAIL_LEASE_MS);
    subscription.timer.unref?.();
  }

  private snapshot(subscription: Subscription): ServerFrame[] {
    const request = subscription.request;
    subscription.revision += 1;
    if (!this.valid(request)) {
      this.closeChannel(request.channel_id);
      return [this.error(subscription, "cancelled", true, false)];
    }
    const result = this.runtime.details(request.tool_ref, request.group_id);
    if (!("content" in result)) {
      if (result.terminal) this.closeChannel(request.channel_id);
      return [this.error(subscription, result.code, result.terminal, !result.terminal)];
    }
    const bytes = Buffer.from(JSON.stringify(result.content), "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const frames: ServerFrame[] = [];
    for (let offset = 0, index = 0; offset < bytes.length; offset += MAX_FRAGMENT_BYTES, index += 1) {
      const chunk = bytes.subarray(offset, offset + MAX_FRAGMENT_BYTES);
      const final = offset + chunk.length >= bytes.length;
      frames.push({ ...this.base(subscription), type: "tool_details_chunk", index, data_base64: chunk.toString("base64"),
        ...(final ? { final: true, total_bytes: bytes.length, sha256: digest } : { final: false }) });
    }
    if (result.content.source === "session") this.closeChannel(request.channel_id);
    return frames;
  }
  private base(subscription: Subscription) {
    const frame = subscription.request;
    return { protocol_version: 2 as const, target_channel_id: frame.channel_id, in_reply_to: frame.id,
      session_id: frame.session_id, leaf_id: frame.leaf_id, group_id: frame.group_id, tool_ref: frame.tool_ref,
      revision: Math.max(1, subscription.revision) };
  }
  private error(subscription: Subscription, code: ErrorCode, terminal: boolean, retryable: boolean): ServerFrame {
    return { ...this.base(subscription), type: "tool_details_error", code, terminal, retryable };
  }
}
