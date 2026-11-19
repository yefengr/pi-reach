import { SESSION_STATUS_LEASE_MS, type ClientFrame, type ServerFrame } from "@pi-reach/protocol/session";
import type { StatusSnapshot } from "./session-status-data.js";

type Subscribe = Extract<ClientFrame, { type: "session_status_subscribe" }>;
type Subscription = { request: Subscribe; expires: number; last: string | null; timer: ReturnType<typeof setTimeout> };
type Binding = { valid: (request: Subscribe) => boolean; send: (frame: ServerFrame) => boolean; subscriptions: Map<string, Subscription> };
export type StatusBinding = { subscribe(request: Subscribe): void; renew(channel: string): void; close(channel: string): void; dispose(): void };
const UPDATE_INTERVAL_MS = 500;

/** 一个 endpoint 共用计算窗口；身份来自已认证的 Owner binding，不接收客户端自报身份。 */
export class SessionStatusService {
  private readonly bindings = new Set<Binding>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cached: StatusSnapshot | null = null;
  private lastComputed = -Infinity;
  private dirty = true;
  private generation = 0;
  private inFlight: { generation: number } | undefined;
  constructor(private readonly read: () => StatusSnapshot | null | Promise<StatusSnapshot | null>) {}

  bind(valid: Binding["valid"], send: Binding["send"]): StatusBinding {
    const binding: Binding = { valid, send, subscriptions: new Map() };
    this.bindings.add(binding);
    const close = (channel: string) => this.close(binding, channel);
    return {
      subscribe: (request) => {
        close(request.channel_id);
        if (!this.bindings.has(binding) || !valid(request)) return;
        const subscription: Subscription = { request, expires: Date.now() + SESSION_STATUS_LEASE_MS, last: null,
          timer: setTimeout(() => close(request.channel_id), SESSION_STATUS_LEASE_MS) };
        subscription.timer.unref?.();
        binding.subscriptions.set(request.channel_id, subscription);
        if (!this.dirty && !this.inFlight && this.cached && Date.now() - this.lastComputed < UPDATE_INTERVAL_MS) this.deliver(binding, subscription, this.cached);
        else this.schedule();
      },
      renew: (channel) => {
        const subscription = binding.subscriptions.get(channel);
        if (!subscription) return;
        if (!this.active(binding, subscription)) { close(channel); return; }
        clearTimeout(subscription.timer);
        subscription.expires = Date.now() + SESSION_STATUS_LEASE_MS;
        subscription.timer = setTimeout(() => close(channel), SESSION_STATUS_LEASE_MS);
        subscription.timer.unref?.();
      },
      close,
      dispose: () => {
        for (const channel of binding.subscriptions.keys()) close(channel);
        this.bindings.delete(binding);
      },
    };
  }

  changed(): void { this.dirty = true; this.schedule(); }
  invalidate(): void {
    this.generation += 1;
    this.inFlight = undefined;
    this.lastComputed = -Infinity;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.cached = null;
    this.dirty = true;
    for (const binding of this.bindings) for (const channel of binding.subscriptions.keys()) this.close(binding, channel);
  }
  dispose(): void { this.invalidate(); this.bindings.clear(); }

  private active(binding: Binding, subscription: Subscription): boolean {
    return binding.subscriptions.get(subscription.request.channel_id) === subscription
      && subscription.expires > Date.now() && binding.valid(subscription.request);
  }
  private close(binding: Binding, channel: string): void {
    const subscription = binding.subscriptions.get(channel);
    if (subscription) clearTimeout(subscription.timer);
    binding.subscriptions.delete(channel);
    if (![...this.bindings].some((item) => item.subscriptions.size > 0) && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
  private schedule(): void {
    if (this.timer || this.inFlight || ![...this.bindings].some((item) => item.subscriptions.size > 0)) return;
    const delay = Math.max(0, this.lastComputed + UPDATE_INTERVAL_MS - Date.now());
    if (delay === 0) { this.compute(); return; }
    this.timer = setTimeout(() => { this.timer = undefined; this.compute(); }, delay);
    this.timer.unref?.();
  }
  private compute(): void {
    for (const binding of this.bindings) for (const subscription of binding.subscriptions.values()) {
      if (!this.active(binding, subscription)) this.close(binding, subscription.request.channel_id);
    }
    if (![...this.bindings].some((item) => item.subscriptions.size > 0)) return;
    const computation = { generation: this.generation };
    this.inFlight = computation;
    this.lastComputed = Date.now();
    // 只消费开始前的变更，等待 reader 期间的变更需在完成后追赶。
    this.dirty = false;
    let snapshot: StatusSnapshot | null | Promise<StatusSnapshot | null> = null;
    try { snapshot = this.read(); } catch { /* 错误帧只携带固定描述，不转发状态或 SDK 异常。 */ }
    if (snapshot !== null && "then" in snapshot) {
      void snapshot.then((value) => this.complete(computation, value), () => this.complete(computation, null));
      return;
    }
    this.complete(computation, snapshot);
  }
  private complete(computation: { generation: number }, snapshot: StatusSnapshot | null): void {
    if (computation.generation !== this.generation || this.inFlight !== computation) return;
    this.cached = snapshot;
    for (const binding of this.bindings) for (const subscription of binding.subscriptions.values()) {
      if (computation.generation !== this.generation) return;
      if (snapshot) { this.deliver(binding, subscription, snapshot); continue; }
      if (this.active(binding, subscription)) binding.send({ protocol_version: 2, type: "protocol_error",
        target_channel_id: subscription.request.channel_id, in_reply_to: subscription.request.id,
        code: "internal_error", message: "Session status is unavailable." });
      this.close(binding, subscription.request.channel_id);
    }
    if (computation.generation !== this.generation || this.inFlight !== computation) return;
    this.inFlight = undefined;
    if (this.dirty) this.schedule();
  }
  private deliver(binding: Binding, subscription: Subscription, snapshot: StatusSnapshot): void {
    const request = subscription.request;
    if (!this.active(binding, subscription) || request.session_id !== snapshot.sessionId) {
      this.close(binding, request.channel_id); return;
    }
    const serialized = JSON.stringify(snapshot.status);
    if (subscription.last === serialized) return;
    const frame: ServerFrame = { protocol_version: 2, type: "session_status", target_channel_id: request.channel_id,
      session_id: snapshot.sessionId, leaf_id: snapshot.leafId, subscription_id: request.id,
      ...(subscription.last === null ? { in_reply_to: request.id } : {}), status: snapshot.status };
    if (!binding.send(frame)) { this.close(binding, request.channel_id); return; }
    if (this.active(binding, subscription)) subscription.last = serialized;
  }
}
