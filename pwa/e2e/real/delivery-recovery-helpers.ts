import { expect, type Page, type WebSocketRoute } from "playwright/test";

/** 观测只保留关联 ID 与计数；仅延迟无正文的查询状态帧，不打印 ct 或 Owner 凭据。 */
type FrameIdentity = { type: string; id?: string; replyTo?: string; clientRequestId?: string; channelId?: string; status?: string; messageId?: string };
function frameIdentity(payload: string | Buffer): FrameIdentity | null {
  try {
    const envelope = JSON.parse(payload.toString()) as { type?: unknown; ct?: unknown };
    if (envelope.type !== "route" || typeof envelope.ct !== "string") return null;
    const frame = JSON.parse(Buffer.from(envelope.ct, "base64").toString("utf8")) as Record<string, unknown>;
    if (typeof frame.type !== "string") return null;
    return {
      type: frame.type,
      ...(typeof frame.id === "string" ? { id: frame.id } : {}),
      ...(typeof frame.in_reply_to === "string" ? { replyTo: frame.in_reply_to } : {}),
      ...(typeof frame.client_request_id === "string" ? { clientRequestId: frame.client_request_id } : {}),
      ...(typeof frame.channel_id === "string" ? { channelId: frame.channel_id } : {}),
      ...(typeof frame.status === "string" ? { status: frame.status } : {}),
      ...(typeof frame.message_id === "string" ? { messageId: frame.message_id } : {}),
    };
  } catch { return null; }
}

export async function installDeliveryRecoveryProbe(page: Page) {
  let mode: "idle" | "drop-delivery" | "recover" = "idle";
  let original: (FrameIdentity & { connection: number }) | undefined;
  let originalConnection: { page: WebSocketRoute; server: WebSocketRoute } | undefined;
  let connections = 0;
  let messageCount = 0;
  let droppedReceipts = 0;
  let heldQueryReply: { route: WebSocketRoute; payload: string | Buffer } | undefined;
  let queryStatus: string | undefined;
  let queryHasMessage = false;
  const queries: Array<FrameIdentity & { connection: number }> = [];
  const statusReplies = new Set<string>();
  await page.routeWebSocket(url => url.hostname === "127.0.0.1" && url.port === "18786", route => {
    const server = route.connectToServer();
    const connection = ++connections;
    route.onMessage(payload => {
      const frame = frameIdentity(payload);
      if (mode !== "idle" && frame?.type === "user_message") {
        if (!original) { original = { ...frame, connection }; originalConnection = { page: route, server }; }
        messageCount += 1;
      }
      if (frame?.type === "user_message_status_request") queries.push({ ...frame, connection });
      server.send(payload);
    });
    server.onMessage(payload => {
      const frame = frameIdentity(payload);
      if (mode === "recover" && frame?.type === "user_message_status" && queries.some(query => query.id === frame.replyTo)) {
        heldQueryReply = { route, payload };
        queryStatus = frame.status;
        queryHasMessage = Boolean(frame.messageId);
        return;
      }
      if (frame?.type === "user_message_status" && frame.replyTo) statusReplies.add(frame.replyTo);
      const originalReceipt = frame?.type === "user_message_status" && frame.clientRequestId === original?.clientRequestId
        || frame?.type === "user_message_started" && frame.replyTo === original?.id;
      // 只丢恢复场景中的接收/启动回执与队列快照；正式事件和真正 Relay 路由保持原样。
      if (mode === "drop-delivery" && (originalReceipt || frame?.type === "queued_message_state")) {
        if (originalReceipt) droppedReceipts += 1;
        return;
      }
      route.send(payload);
    });
  });
  return {
    arm() { mode = "drop-delivery"; },
    async reconnectOwner() {
      if (!originalConnection) throw new Error("Delivery recovery probe has no active message connection.");
      mode = "recover";
      await Promise.all([originalConnection.page.close({ code: 1012 }), originalConnection.server.close({ code: 1012 })]);
    },
    releaseQueryReply() {
      if (!heldQueryReply) throw new Error("Delivery recovery query has not returned.");
      const frame = frameIdentity(heldQueryReply.payload);
      if (frame?.replyTo) statusReplies.add(frame.replyTo);
      heldQueryReply.route.send(heldQueryReply.payload);
      heldQueryReply = undefined;
    },
    snapshot() {
      const query = queries.find(item => item.clientRequestId === original?.clientRequestId);
      return {
        messageCount, droppedReceipts, queryReplyHeld: heldQueryReply !== undefined, queryStatus, queryHasMessage,
        queryCount: queries.filter(item => item.clientRequestId === original?.clientRequestId).length,
        queryId: query?.id,
        queriedOnNewConnection: Boolean(query && query.connection !== original?.connection),
        replyReceived: Boolean(query?.id && statusReplies.has(query.id)),
      };
    },
    hasStatusReply(id: string) { return statusReplies.has(id); },
  };
}

export async function verifyMessageDeliveryRecovery(input: {
  page: Page;
  otherOwner: Page;
  probe: Awaited<ReturnType<typeof installDeliveryRecoveryProbe>>;
  otherProbe: Awaited<ReturnType<typeof installDeliveryRecoveryProbe>>;
  sessionId: string;
  runCompose: (args: readonly string[]) => Promise<string>;
}) {
  const { page, otherOwner, probe, otherProbe } = input;
  const text = `E2E delivery recovery ${crypto.randomUUID()}`;
  probe.arm();
  await page.getByRole("textbox").fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(otherOwner.locator(".pwa-message.user:not(.pending)").filter({ hasText: text })).toHaveCount(1);
  await expect.poll(() => probe.snapshot().droppedReceipts).toBeGreaterThan(0);
  expect(probe.snapshot().messageCount).toBe(1);
  expect(probe.snapshot().queryCount).toBe(0);
  // 仅断开提交消息的 Owner；Relay 和 Pi 保持运行，保留仍有效的有界投递记录。
  // PWA 的 channel ID 为页面级稳定值，真正重连由 WebSocket 实例变化证明。
  await probe.reconnectOwner();
  await expect.poll(() => probe.snapshot().queriedOnNewConnection).toBe(true);
  await expect(page.getByLabel("Connected", { exact: true })).toBeVisible();
  await expect.poll(() => probe.snapshot().queryReplyHeld).toBe(true);
  expect(probe.snapshot()).toMatchObject({ queryStatus: "committed", queryHasMessage: true });
  const check = page.getByRole("button", { name: "Check status", exact: true });
  await expect(check).toBeDisabled();
  // 真实浏览器等待超时，不改生产常量或伪造回执；迟到的真实 Pi 状态仍须合并正式记录。
  await expect(check).toBeEnabled({ timeout: 20_000 });
  probe.releaseQueryReply();
  await expect.poll(() => probe.snapshot().replyReceived).toBe(true);
  await expect(page.locator(".pwa-message.user").filter({ hasText: text })).toHaveCount(1);
  await expect(page.locator(".pwa-message.user.pending")).toHaveCount(0);
  await expect(page.getByText("Not confirmed", { exact: true })).toHaveCount(0);
  const recovered = probe.snapshot();
  expect(recovered.queryCount).toBe(1);
  expect(recovered.messageCount).toBe(1);
  expect(recovered.queriedOnNewConnection).toBe(true);
  expect(otherProbe.hasStatusReply(recovered.queryId!)).toBe(false);
  await expect(otherOwner.locator(".pwa-message.user").filter({ hasText: text })).toHaveCount(1);
  // 原生用户记录数量是实际 Pi 投递证据；SDK 调用次数另由 queue/binding 回归直接断言。
  const script = `const fs=require('node:fs'),path=require('node:path');
    const sessionId=process.argv[1],text=process.argv[2];let count=0;
    function visit(dir){for(const name of fs.readdirSync(dir)){const file=path.join(dir,name);
      if(fs.statSync(file).isDirectory())visit(file);else if(name.endsWith('.jsonl')){
        const entries=fs.readFileSync(file,'utf8').split('\\n').filter(Boolean).map(line=>JSON.parse(line));
        if(entries[0]?.type!=='session'||entries[0].id!==sessionId)continue;
        count+=entries.filter(entry=>entry.type==='message'&&entry.message?.role==='user'&&
          (typeof entry.message.content==='string'?entry.message.content===text:
            entry.message.content?.some(block=>block.type==='text'&&block.text===text))).length;}}}
    visit('/home/pi/.pi/agent/sessions');console.log(JSON.stringify(count));`;
  await expect.poll(async () => JSON.parse(await input.runCompose([
    "exec", "-T", "interactive", "node", "-e", script, input.sessionId, text,
  ])) as number).toBe(1);
}
