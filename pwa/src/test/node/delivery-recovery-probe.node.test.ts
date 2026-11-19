import type { Page } from "playwright/test";
import { describe, expect, it } from "vitest";
import { installDeliveryRecoveryProbe } from "../../../e2e/real/delivery-recovery-helpers";

// 复现真实重连竞态：同一条 committed 回复经新旧两个连接各到一次，旧连接已关闭。
// 只用占位身份编码 route 帧，不携带 Owner 凭据、消息正文或真实查询 ID。
type Frame = Record<string, unknown>;
type Payload = string | Buffer;
type FrameHandler = (payload: Payload) => void;

const relayUrl = new URL("ws://127.0.0.1:18786/api/ws");
const message = { type: "user_message", id: "message-1", client_request_id: "request-1", channel_id: "channel-1" };
const statusRequest = { type: "user_message_status_request", id: "query-1", client_request_id: "request-1", channel_id: "channel-1" };
const committedReply = (): Frame => ({
  type: "user_message_status", id: "reply-1", in_reply_to: "query-1", client_request_id: "request-1",
  status: "committed", message_id: "message-1",
});

function encodeFrame(frame: Frame): string {
  return JSON.stringify({ type: "route", ct: Buffer.from(JSON.stringify(frame), "utf8").toString("base64") });
}

function decodePayload(payload: Payload): Frame {
  const envelope = JSON.parse(payload.toString()) as { ct: string };
  return JSON.parse(Buffer.from(envelope.ct, "base64").toString("utf8")) as Frame;
}

/** 双向 WebSocketRoute 替身：page 侧经 connectToServer 得到 server 侧，send 记录实际下发的帧。 */
class FakeWebSocketRoute {
  readonly sent: Frame[] = [];
  closedCode: number | undefined;
  private handlers: FrameHandler[] = [];
  private peer: FakeWebSocketRoute | undefined;

  link(peer: FakeWebSocketRoute) { this.peer = peer; peer.peer = this; }
  onMessage(handler: FrameHandler) { this.handlers.push(handler); }
  connectToServer() {
    if (!this.peer) throw new Error("Fake route has no server peer.");
    return this.peer;
  }
  send(payload: Payload) { this.sent.push(decodePayload(payload)); }
  async close(options?: { code?: number }) { this.closedCode = options?.code ?? 1000; }
  /** 从该方向注入一帧，等价于浏览器或 Relay 对端发来消息。 */
  emit(frame: Frame) {
    const payload = encodeFrame(frame);
    for (const handler of [...this.handlers]) handler(payload);
  }
  frames(type: string) { return this.sent.filter(frame => frame.type === type); }
}

class FakePage {
  private accepts: ((url: URL) => boolean) | undefined;
  private handler: ((route: FakeWebSocketRoute) => void) | undefined;
  private connections: Array<{ page: FakeWebSocketRoute; server: FakeWebSocketRoute }> = [];

  async routeWebSocket(matcher: (url: URL) => boolean, handler: (route: FakeWebSocketRoute) => void) {
    this.accepts = matcher;
    this.handler = handler;
  }

  /** 模拟浏览器新建一条 WebSocket 连接，并让探针接管双向处理。 */
  connect() {
    if (!this.accepts || !this.handler) throw new Error("Delivery recovery probe is not installed.");
    if (!this.accepts(relayUrl)) throw new Error("Delivery recovery probe does not match the relay URL.");
    const pageRoute = new FakeWebSocketRoute();
    const serverRoute = new FakeWebSocketRoute();
    pageRoute.link(serverRoute);
    this.connections.push({ page: pageRoute, server: serverRoute });
    this.handler(pageRoute);
    return { page: pageRoute, server: serverRoute };
  }
}

async function recoverAfterReconnect() {
  const fakePage = new FakePage();
  const probe = await installDeliveryRecoveryProbe(fakePage as unknown as Page);
  const first = fakePage.connect();
  probe.arm();
  first.page.emit(message);
  expect(probe.snapshot()).toMatchObject({ messageCount: 1, queryCount: 0 });
  await probe.reconnectOwner();
  expect([first.page.closedCode, first.server.closedCode]).toEqual([1012, 1012]);
  // 重连后 PWA 在新连接上发起同一条消息的状态查询。
  const second = fakePage.connect();
  second.page.emit(statusRequest);
  expect(probe.snapshot()).toMatchObject({ queryCount: 1, queriedOnNewConnection: true, queryReplyHeld: false });
  return { probe, first, second };
}

describe("delivery recovery probe query reply routing", () => {
  it("keeps the committed reply on the connection that issued the query", async () => {
    const { probe, first, second } = await recoverAfterReconnect();
    second.server.emit(committedReply());
    expect(probe.snapshot()).toMatchObject({ queryReplyHeld: true, queryStatus: "committed", queryHasMessage: true });
    // 同一回复经已关闭的旧连接补推时不得抢占新连接上的迟到回执。
    first.server.emit(committedReply());
    expect(probe.snapshot().queryReplyHeld).toBe(true);
    probe.releaseQueryReply();
    expect(second.page.frames("user_message_status")).toEqual([committedReply()]);
    expect(first.page.frames("user_message_status")).toEqual([]);
    expect(probe.snapshot().replyReceived).toBe(true);
    // 浏览器实际消费迟到回执后才发出 observed，证明合并路径仍可被观测。
    second.page.emit({ type: "user_message_observed", client_request_id: "request-1", message_id: "message-1" });
    expect(probe.snapshot().messageObserved).toBe(true);
  });

  it("ignores a stale copy that arrives before the querying connection copy", async () => {
    const { probe, first, second } = await recoverAfterReconnect();
    first.server.emit(committedReply());
    expect(probe.snapshot().queryReplyHeld).toBe(false);
    second.server.emit(committedReply());
    expect(probe.snapshot().queryReplyHeld).toBe(true);
    probe.releaseQueryReply();
    expect(first.page.frames("user_message_status")).toEqual([]);
    expect(second.page.frames("user_message_status")).toEqual([committedReply()]);
  });

  it("releases a single copy and still counts replayed receipts", async () => {
    const { probe, first, second } = await recoverAfterReconnect();
    second.server.emit(committedReply());
    probe.releaseQueryReply();
    expect(probe.snapshot()).toMatchObject({ queryReplyHeld: false, replyReceived: true, replayedReceipts: 0 });
    expect(second.page.frames("user_message_status")).toEqual([committedReply()]);
    expect(first.page.frames("user_message_status")).toEqual([]);
    // 原发送尝试的补推确认仍走丢弃分支，不改变既有 replay 语义。
    second.server.emit({
      type: "user_message_status", id: "reply-2", in_reply_to: "message-1", client_request_id: "request-1",
      status: "committed", message_id: "message-1",
    });
    expect(probe.snapshot().replayedReceipts).toBe(1);
    expect(second.page.frames("user_message_status")).toEqual([committedReply()]);
  });
});
