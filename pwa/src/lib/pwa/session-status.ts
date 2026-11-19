import { SESSION_STATUS_KEEPALIVE_MS, SESSION_STATUS_LEASE_MS, SESSION_STATUS_REQUEST_TIMEOUT_MS, type ClientFrame, type ServerFrame, type SessionStatus } from "@pi-reach/protocol/session";

export type SessionStatusView = { kind: "offline" | "loading" | "unsupported" | "unavailable" } | { kind: "ready"; status: SessionStatus };
export type SessionStatusConnection = { origin: object; channelId: string; sessionId: string; leafId: string | null; send: (frame: ClientFrame) => boolean };
type Subscription = { connection: SessionStatusConnection; id: string; confirmed: boolean; renewedAt: number; retry: boolean; ping?: { id: string; sentAt: number } };
const PREFIX = "session-status:";

/** 状态只属于当前 ready 代次，不借快照的 tip 推进或校验时间线。 */
export class SessionStatusController {
  private current: Subscription | null = null;
  private connection: SessionStatusConnection | null = null;
  private view: SessionStatusView = { kind: "offline" };
  private viewSessionId: string | null = null;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private visible = true;
  private unsupported = false;
  constructor(private readonly makeId: () => string = () => crypto.randomUUID()) {}
  getSnapshot = (): SessionStatusView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(view: SessionStatusView): void { this.view = view; for (const listener of this.listeners) listener(); }
  private stop(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
  private schedule(callback: () => void, delay: number): void { this.stop(); this.timer = setTimeout(callback, Math.max(0, delay)); }
  disconnect = (preserve = true): void => {
    this.stop(); this.current = null; this.connection = null; this.unsupported = false;
    if (!preserve || this.view.kind !== "ready") {
      this.viewSessionId = null;
      this.publish({ kind: "offline" });
    }
  };
  start(connection: SessionStatusConnection): void {
    this.disconnect(this.viewSessionId === connection.sessionId);
    this.connection = connection;
    if (this.view.kind !== "ready") this.publish({ kind: "loading" });
    if (this.visible) this.request(false);
  }
  setVisible = (visible: boolean): void => {
    if (this.visible === visible) return;
    this.visible = visible;
    this.stop(); this.current = null;
    if (visible && this.connection && !this.unsupported) this.request(false);
  };
  private fail(current: Subscription, unsupported = false): void {
    if (this.current !== current) return;
    this.stop(); this.current = null; this.unsupported = unsupported;
    this.publish({ kind: unsupported ? "unsupported" : "unavailable" });
  }
  private request(retry: boolean): void {
    const connection = this.connection;
    if (!connection || !this.visible || this.unsupported) return;
    this.stop();
    const current: Subscription = { connection, id: `${PREFIX}${this.makeId()}`, confirmed: false, renewedAt: Date.now(), retry };
    this.current = current;
    if (this.view.kind !== "ready") this.publish({ kind: "loading" });
    this.schedule(() => this.fail(current), SESSION_STATUS_REQUEST_TIMEOUT_MS);
    if (!connection.send({ protocol_version: 2, type: "session_status_subscribe", id: current.id, channel_id: connection.channelId, session_id: connection.sessionId, leaf_id: connection.leafId })) this.fail(current);
  }
  private recover(current: Subscription): void {
    if (this.current !== current) return;
    if (current.retry) this.fail(current);
    else this.request(true);
  }
  private heartbeat(current: Subscription): void {
    if (this.current !== current || !this.visible) return;
    if (Date.now() >= current.renewedAt + SESSION_STATUS_LEASE_MS || current.ping) { this.recover(current); return; }
    const connection = current.connection;
    this.send({ protocol_version: 2, type: "ping", id: `${PREFIX}${this.makeId()}`, channel_id: connection.channelId, session_id: connection.sessionId, leaf_id: connection.leafId }, connection.origin, connection.send);
  }
  /** 工具详情通过此入口发送：已有有效心跳时共享续租，不重复发送。 */
  send(frame: ClientFrame, origin: object, transport: (frame: ClientFrame) => boolean): boolean {
    const current = this.current;
    if (frame.type !== "ping" || !current?.confirmed || current.connection.origin !== origin || frame.channel_id !== current.connection.channelId || frame.session_id !== current.connection.sessionId) return transport(frame);
    const now = Date.now();
    if (current.ping && now - current.ping.sentAt < SESSION_STATUS_KEEPALIVE_MS || !current.ping && now - current.renewedAt < SESSION_STATUS_KEEPALIVE_MS) return true;
    if (now >= current.renewedAt + SESSION_STATUS_LEASE_MS) { this.recover(current); return transport(frame); }
    current.ping = { id: frame.id, sentAt: now };
    this.schedule(() => this.recover(current), SESSION_STATUS_KEEPALIVE_MS);
    const sent = transport(frame);
    if (!sent) this.fail(current);
    return sent;
  }
  receive(frame: ServerFrame, origin: object): boolean {
    const current = this.current;
    const ownReply = (frame.type === "pong" || frame.type === "protocol_error") && frame.in_reply_to?.startsWith(PREFIX);
    const isStatus = frame.type === "session_status";
    if (!current || origin !== current.connection.origin || "target_channel_id" in frame && frame.target_channel_id !== current.connection.channelId) return Boolean(ownReply || isStatus);
    if (frame.type === "protocol_error" && (frame.in_reply_to === current.id || frame.in_reply_to === current.ping?.id)) {
      this.fail(current, frame.in_reply_to === current.id && frame.code === "protocol_upgrade_required");
      return true;
    }
    if (frame.type === "pong" && current.ping && frame.in_reply_to === current.ping.id) {
      const { sentAt } = current.ping;
      if (Date.now() >= current.renewedAt + SESSION_STATUS_LEASE_MS || Date.now() - sentAt >= SESSION_STATUS_KEEPALIVE_MS) this.recover(current);
      else {
        current.renewedAt = sentAt; current.ping = undefined;
        this.schedule(() => this.heartbeat(current), sentAt + SESSION_STATUS_KEEPALIVE_MS - Date.now());
      }
    }
    if (!isStatus) return Boolean(ownReply);
    if (frame.session_id !== current.connection.sessionId || frame.subscription_id !== current.id || !current.confirmed && frame.in_reply_to !== current.id) return true;
    // 首份只确认一次，不能用重送的旧首份覆盖其后的实时推送。
    if (current.confirmed && frame.in_reply_to !== undefined) return true;
    if (!current.confirmed) {
      if (Date.now() - current.renewedAt >= SESSION_STATUS_REQUEST_TIMEOUT_MS) { this.fail(current); return true; }
      current.confirmed = true;
      this.schedule(() => this.heartbeat(current), current.renewedAt + SESSION_STATUS_KEEPALIVE_MS - Date.now());
    }
    if (Date.now() >= current.renewedAt + SESSION_STATUS_LEASE_MS) { this.recover(current); return true; }
    this.viewSessionId = current.connection.sessionId;
    this.publish({ kind: "ready", status: frame.status });
    return true;
  }
}
