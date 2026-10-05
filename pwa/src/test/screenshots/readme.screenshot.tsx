// 生成 README 截图（docs/assets/screenshot-*.png）：运行 `pnpm --filter pwa screenshots`。
// screenshot-mobile-showcase-en.png 把浅色、深色手机截图并排放在宽画布上，供只按原始像素显示图片的商店页使用。
// 使用真实的 PwaApp 界面与演示数据；Relay 与会话通道由本文件模拟，不连接真实 Relay、Pi 或模型。
// 文件名不匹配 *.browser.test.tsx，不会随 `pnpm test` 运行。
import { expect, test, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";
import { PwaAppShell } from "@/components/pwa/pwa-app-shell";
import { PwaApp } from "@/components/pwa/pwa-app";
import { connectionBannerTiming } from "@/components/pwa/pwa-app-actions";
import { setLanguagePreference } from "@/lib/i18n";
import { APPEARANCE_STORAGE_KEY } from "@/lib/ui/appearance";
import { generateOwnerKeyPair } from "@/lib/pi-reach/crypto";
import type { ClientFrame } from "@/lib/pi-reach/protocol-v2";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { makePwaDeviceId, makePwaEndpointId, openPwaDatabase } from "@/lib/pwa/db";
import { toStoredKey } from "@/lib/pwa/runtime";
import { mergeTimelineEvents } from "@/lib/pwa/timeline-store";

/** commands.writeFile 相对 pwa/ 项目根解析，指向仓库根的 docs/assets/。 */
const OUTPUT_DIR = "../docs/assets";
const DEVICE = "demo-device-key";
const SHOP = "endpoint-shop-web";
const API = "endpoint-api-server";
const SESSION = "session-demo";
const LEAF = "leaf-demo";
const SENDER = "sender-demo";
/** 手机截图占宽幅图宽度的比例：README 正文约 920px 宽时，手机约 330px，接近真机字号。 */
const SHOWCASE_PHONE_WIDTH_RATIO = 0.36;
const SHOWCASE_PADDING = 120;
const SHOWCASE_GAP = 120;
const SHOWCASE_RADIUS = 36;
const SHOWCASE_BORDER_WIDTH = 2;
/** 与浅色主题 --pwa-panel、--pwa-line 一致。 */
const SHOWCASE_BACKGROUND = "#F7F7F7";
const SHOWCASE_BORDER = "#E0E0E0";

type Relay = { state: string; emitControl: (frame: unknown) => void };
type Channel = { channelId: string; frames: ClientFrame[]; emit: (frame: unknown) => void };
const harness = vi.hoisted(() => ({ relays: [] as Relay[], channels: [] as Channel[] }));

vi.mock("@/lib/pi-reach/relay-client", () => ({
  RelayClient: class {
    state = "idle";
    private readonly stateListeners: Array<(state: string) => void> = [];
    private readonly controlListeners: Array<(frame: unknown) => void> = [];
    constructor() { harness.relays.push(this); }
    on(event: string, callback: (value: unknown) => void) {
      if (event === "state") this.stateListeners.push(callback as (state: string) => void);
      if (event === "control") this.controlListeners.push(callback);
      return () => undefined;
    }
    async connect() { this.state = "open"; }
    subscribeEndpoints() { return this.state === "open"; }
    sendControl() { return this.state === "open"; }
    sendRoute() { return this.state === "open"; }
    emitControl(frame: unknown) { for (const listener of this.controlListeners) listener(frame); }
    close() { this.state = "closed"; for (const listener of this.stateListeners) listener("closed"); }
  },
}));

vi.mock("@/lib/pi-reach/peer-channel", () => ({
  PeerChannel: class {
    readonly channelId: string;
    readonly frames: ClientFrame[] = [];
    constructor(options: { channelId?: string; onFrame?: (frame: unknown) => void }) {
      this.channelId = options.channelId ?? `channel-${harness.channels.length}`;
      harness.channels.push({ channelId: this.channelId, frames: this.frames, emit: (frame) => options.onFrame?.(frame) });
    }
    send(frame: ClientFrame) { this.frames.push(frame); return true; }
    sendPairRequest(frame: ClientFrame) { return this.send(frame); }
    close() {}
  },
}));

type Lang = "zh" | "en";
const copy = {
  zh: {
    shopName: "修复登录超时",
    apiName: "重构订单导出",
    user: "登录接口偶尔会超时，帮我查一下原因并修复。",
    think1: "先看会话刷新的实现，再跑一下相关测试，确认能不能复现。",
    think2: "另一个请求持有会话锁时，refreshSession 会一直等下去。",
    text2: "找到原因了：`refreshSession` 获取会话锁时没有设置超时。我给它加上 2 秒超时，超时后返回 409，让客户端重试。",
    final: "登录超时已修复。\n\n- **原因**：`refreshSession` 等待会话锁时没有超时，另一个请求持有锁时会一直挂起，直到网关 30 秒超时。\n- **修改**：`lock.acquire` 加上 2 秒超时，超时后返回 `409`，客户端会自动重试。\n- **验证**：`pnpm test session` 12 项全部通过。\n\n需要我再补一个并发刷新的回归测试吗？",
    finalMarker: "需要我再补一个",
    older: "给 README 补充自托管说明",
    olderReply: "已补充 Docker 自托管步骤。",
  },
  en: {
    shopName: "Fix login timeout",
    apiName: "Refactor order export",
    user: "Login sometimes times out. Can you find out why and fix it?",
    think1: "Read the session refresh code first, then run the related tests to see if it reproduces.",
    think2: "When another request holds the session lock, refreshSession waits forever.",
    text2: "Found it: `refreshSession` waits for the session lock without a timeout. I'll add a 2-second timeout and return 409 so the client retries.",
    final: "The login timeout is fixed.\n\n- **Cause**: `refreshSession` waited for the session lock with no timeout, so a request could hang until the gateway's 30-second timeout.\n- **Change**: `lock.acquire` now times out after 2 seconds and returns `409`; the client retries automatically.\n- **Verified**: all 12 tests in `pnpm test session` pass.\n\nWant me to add a regression test for concurrent refreshes too?",
    finalMarker: "Want me to add",
    older: "Add self-hosting steps to the README",
    olderReply: "Added Docker setup steps.",
  },
} as const;

const readSource = [
  "export async function refreshSession(userId: string) {",
  "  const lock = getSessionLock(userId);",
  "  await lock.acquire(userId);",
  "  try {",
  "    const session = await store.load(userId);",
  "    return await rotateToken(session);",
  "  } finally {",
  "    lock.release(userId);",
  "  }",
  "}",
].join("\n");
const failingTests = "✗ refreshes an expired session while another request holds the lock (5003 ms)\n  Error: Timeout of 5000ms exceeded\n\nTests  1 failed | 11 passed (12)";
const passingTests = "✓ src/server/session.test.ts (12 tests) 1.8s\n\nTests  12 passed (12)";

function conversation(lang: Lang, base: number): TimelineEvent[] {
  const t = copy[lang];
  const common = (id: string, seq: number, seconds: number) => ({ event_id: id, event_seq: seq, session_id: SESSION, leaf_id: LEAF, timestamp: base + seconds * 1000 });
  const tool = (id: string, seq: number, seconds: number, name: string, args: Record<string, string>, result: string): TimelineEvent => ({
    ...common(id, seq, seconds), group_id: "run-1", kind: "tool", tool_call_id: `call-${id}`, tool: name, args, truncated: false, status: "complete", result,
  });
  return [
    { ...common("m-user-1", 1, 0), group_id: "user-1", kind: "user", message_id: "m-user-1", blocks: [{ type: "text", text: t.user }], origin: "pwa", sender_ref: SENDER, delivery: "normal", status: "committed" },
    { ...common("a-1", 2, 3), group_id: "run-1", kind: "assistant", status: "complete", blocks: [{ type: "thinking", text: t.think1 }] },
    tool("read-1", 3, 5, "read", { path: "src/server/session.ts" }, readSource),
    tool("bash-1", 4, 14, "bash", { command: "pnpm test session" }, failingTests),
    { ...common("a-2", 5, 20), group_id: "run-1", kind: "assistant", status: "complete", blocks: [{ type: "thinking", text: t.think2 }, { type: "text", text: t.text2 }] },
    tool("edit-1", 6, 24, "edit", { path: "src/server/session.ts", oldText: "  await lock.acquire(userId);", newText: "  const acquired = await lock.acquire(userId, { timeoutMs: 2000 });\n  if (!acquired) throw new SessionBusyError(userId);" }, "Successfully replaced text in src/server/session.ts."),
    tool("bash-2", 7, 33, "bash", { command: "pnpm test session" }, passingTests),
    { ...common("a-3", 8, 38), group_id: "run-1", kind: "assistant", status: "complete", blocks: [{ type: "text", text: t.final }] },
    { ...common("end-1", 9, 38), group_id: "run-1", kind: "run_end", status: "complete" },
  ];
}

function lastFrameId(frames: ClientFrame[], type: ClientFrame["type"]): string {
  const frame = frames.findLast((candidate) => candidate.type === type);
  if (!frame || !("id" in frame)) throw new Error(`Expected a ${type} frame.`);
  return frame.id;
}

type Appearance = "light" | "dark";

async function seed(lang: Lang, appearance: Appearance) {
  harness.relays.length = 0;
  harness.channels.length = 0;
  connectionBannerTiming.delayMs = 0;
  window.localStorage.clear();
  window.localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
  setLanguagePreference(lang);
  const db = await openPwaDatabase();
  await db.transaction("rw", [db.identities, db.devices, db.endpoints, db.events, db.sessions, db.settings], async () => {
    await Promise.all([db.identities.clear(), db.devices.clear(), db.endpoints.clear(), db.events.clear(), db.sessions.clear(), db.settings.clear()]);
  });
  const identity = await generateOwnerKeyPair();
  await Promise.all([
    db.identities.put({ id: "owner", publicKey: toStoredKey(identity.publicKey), secretKey: toStoredKey(identity.privateKey), createdAt: Date.now() }),
    db.devices.put({ id: makePwaDeviceId(DEVICE), deviceId: DEVICE, relayUrl: "https://pi-reach-relay.yefengr.cn", pairedAt: "2026-09-20T08:00:00.000Z", hostname: "MacBook Pro" }),
    db.endpoints.put({ id: makePwaEndpointId(DEVICE, SHOP), deviceId: DEVICE, endpointId: SHOP, runtimeInstanceId: "runtime-shop", kind: "interactive", cwd: "/Users/demo/code/shop-web", updatedAt: Date.now() }),
    db.settings.put({ key: `active_endpoint:${makePwaDeviceId(DEVICE)}`, value: SHOP }),
  ]);
  const olderBase = Date.now() - 26 * 60 * 60 * 1000;
  const t = copy[lang];
  await mergeTimelineEvents({ deviceId: DEVICE, endpointId: SHOP, sessionId: "session-older", leafId: "leaf-older" }, [
    { event_id: "old-user", event_seq: 1, session_id: "session-older", leaf_id: "leaf-older", timestamp: olderBase, group_id: "old-u", kind: "user", message_id: "old-user", blocks: [{ type: "text", text: t.older }], origin: "pwa", sender_ref: SENDER, delivery: "normal", status: "committed" },
    { event_id: "old-reply", event_seq: 2, session_id: "session-older", leaf_id: "leaf-older", timestamp: olderBase + 40_000, group_id: "old-run", kind: "assistant", status: "complete", blocks: [{ type: "text", text: t.olderReply }] },
  ]);
}

/** 渲染演示会话并返回 PNG 的 base64。 */
async function capture(lang: Lang, width: number, height: number, appearance: Appearance = "light"): Promise<string> {
  await page.viewport(width, height);
  await seed(lang, appearance);
  const screen = await render(<PwaUiProvider><PwaAppShell runtimeNotice={null}><PwaApp /></PwaAppShell></PwaUiProvider>);
  await vi.waitFor(() => expect(harness.relays[0]?.state).toBe("open"));
  harness.relays[0]!.emitControl({
    type: "endpoints",
    device_id: DEVICE,
    endpoints: [
      { endpoint_id: SHOP, runtime_instance_id: "runtime-shop", metadata: { kind: "interactive", name: copy[lang].shopName, cwd: "/Users/demo/code/shop-web", model: "claude-sonnet-4-5", thinking: "medium", working: false } },
      { endpoint_id: API, runtime_instance_id: "runtime-api", metadata: { kind: "interactive", name: copy[lang].apiName, cwd: "/Users/demo/code/api-server", model: "gpt-5", thinking: "high", working: true } },
    ],
  });
  await vi.waitFor(() => expect(harness.channels.length).toBeGreaterThan(0));
  const channel = harness.channels[0]!;
  await vi.waitFor(() => expect(channel.frames.some((frame) => frame.type === "session_hello")).toBe(true));
  channel.emit({
    protocol_version: 2, type: "session_ready", target_channel_id: channel.channelId, in_reply_to: lastFrameId(channel.frames, "session_hello"),
    session_id: SESSION, leaf_id: LEAF, self_sender_ref: SENDER, head_seq: 9,
  });
  await vi.waitFor(() => expect(channel.frames.some((frame) => frame.type === "session_sync")).toBe(true));
  channel.emit({
    protocol_version: 2, type: "session_history_chunk", target_channel_id: channel.channelId, in_reply_to: lastFrameId(channel.frames, "session_sync"),
    session_id: SESSION, leaf_id: LEAF, chunk_index: 0, events: conversation(lang, Date.now() - 6 * 60 * 1000), fragments: [], final_chunk: true, eos: true,
  });
  await vi.waitFor(() => expect(document.body.textContent).toContain(copy[lang].finalMarker), { timeout: 10_000 });
  // 等待折叠动画与滚动定位完成。
  await new Promise((resolve) => setTimeout(resolve, 1200));
  // 字体度量因系统而异；放不下时按溢出量加高视口，让对话从提问开始完整显示。
  // 不滚动列表：离开底部会出现"回到最新"按钮。
  const list = document.querySelector<HTMLElement>(".pwa-message-list");
  if (!list) throw new Error("Expected the message list to render.");
  const overflow = list.scrollHeight - list.clientHeight;
  if (overflow > 0) {
    await page.viewport(width, height + overflow);
    await vi.waitFor(() => expect(list.scrollHeight).toBeLessThanOrEqual(list.clientHeight));
  }
  await vi.waitFor(() => expect(document.querySelector(".pwa-latest-button")).toBeNull());
  const png = await page.screenshot({ save: false });
  await screen.unmount();
  return png;
}

async function writePng(name: string, base64: string) {
  await commands.writeFile(`${OUTPUT_DIR}/screenshot-${name}.png`, base64, "base64");
}

function loadImage(base64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode the screenshot."));
    image.src = `data:image/png;base64,${base64}`;
  });
}

/** 把同尺寸的手机截图并排画到宽画布上，返回 PNG 的 base64。 */
async function composeShowcase(screens: string[]): Promise<string> {
  const images = await Promise.all(screens.map(loadImage));
  const { naturalWidth: phoneWidth, naturalHeight: phoneHeight } = images[0]!;
  const rowWidth = images.length * phoneWidth + (images.length - 1) * SHOWCASE_GAP;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(Math.round(phoneWidth / SHOWCASE_PHONE_WIDTH_RATIO), rowWidth + 2 * SHOWCASE_PADDING);
  canvas.height = phoneHeight + 2 * SHOWCASE_PADDING;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable.");
  context.fillStyle = SHOWCASE_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  let x = (canvas.width - rowWidth) / 2;
  for (const image of images) {
    context.save();
    context.beginPath();
    context.roundRect(x, SHOWCASE_PADDING, phoneWidth, phoneHeight, SHOWCASE_RADIUS);
    context.clip();
    context.drawImage(image, x, SHOWCASE_PADDING, phoneWidth, phoneHeight);
    context.restore();
    context.lineWidth = SHOWCASE_BORDER_WIDTH;
    context.strokeStyle = SHOWCASE_BORDER;
    context.beginPath();
    context.roundRect(x, SHOWCASE_PADDING, phoneWidth, phoneHeight, SHOWCASE_RADIUS);
    context.stroke();
    x += phoneWidth + SHOWCASE_GAP;
  }
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

test("desktop zh", async () => { await writePng("desktop-zh", await capture("zh", 1440, 900)); });
test("mobile zh", async () => { await writePng("mobile-zh", await capture("zh", 430, 932)); });
test("desktop en", async () => { await writePng("desktop-en", await capture("en", 1440, 900)); });
test("mobile en", async () => {
  const light = await capture("en", 430, 932);
  await writePng("mobile-en", light);
  await writePng("mobile-showcase-en", await composeShowcase([light, await capture("en", 430, 932, "dark")]));
});
