import { afterEach, expect, test, vi } from "vitest";
import { SESSION_STATUS_KEEPALIVE_MS, SESSION_STATUS_REQUEST_TIMEOUT_MS, type ClientFrame, type ServerFrame, type SessionStatus } from "@pi-reach/protocol/session";
import { SessionStatusController } from "./session-status";

const controllers: SessionStatusController[] = [];
const status: SessionStatus = { context: null, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, cache_hit_rate_session: null, cache_hit_rate_latest: null }, branch: "synthetic", extensions: [] };
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let counter = 0;
  const controller = new SessionStatusController(() => String(++counter));
  controllers.push(controller);
  const frames: ClientFrame[] = [];
  const connection = { origin: {}, channelId: "channel", sessionId: "session", leafId: "leaf", send: (frame: ClientFrame) => { frames.push(frame); return true; } };
  controller.start(connection);
  const snapshot = (id = frames.find(frame => frame.type === "session_status_subscribe")!.id): Extract<ServerFrame, { type: "session_status" }> => ({ protocol_version: 2, type: "session_status", target_channel_id: "channel", session_id: "session", leaf_id: "ahead-tip", subscription_id: id, in_reply_to: id, status });
  const receive = (frame: ServerFrame) => controller.receive(frame, connection.origin);
  return { controller, connection, frames, snapshot, receive };
}
afterEach(() => { controllers.splice(0).forEach(controller => controller.disconnect(false)); vi.useRealTimers(); });

test("首份关联订阅和 origin，不按时间线 tip 相等过滤；后续整体替换", () => {
  const { controller, snapshot, receive } = setup();
  controller.receive(snapshot(), {});
  receive({ ...snapshot(), target_channel_id: "other" });
  receive({ ...snapshot(), session_id: "other" });
  receive({ ...snapshot(), in_reply_to: undefined });
  expect(controller.getSnapshot()).toEqual({ kind: "loading" });
  receive(snapshot());
  expect(controller.getSnapshot()).toEqual({ kind: "ready", status });
  receive({ ...snapshot(), in_reply_to: undefined, leaf_id: "future-tip", status: { ...status, branch: "new" } });
  expect(controller.getSnapshot()).toMatchObject({ kind: "ready", status: { branch: "new" } });
});
test("临时断线停止计时但保留快照；同 session 重连只接收新订阅", () => {
  const { controller, connection, snapshot, receive, frames } = setup();
  const old = snapshot(); receive(old);
  controller.disconnect();
  expect(controller.getSnapshot()).toEqual({ kind: "ready", status });
  receive({ ...old, status: { ...status, branch: "late" } });
  vi.advanceTimersByTime(SESSION_STATUS_REQUEST_TIMEOUT_MS * 4);
  expect(controller.getSnapshot()).toEqual({ kind: "ready", status });
  expect(frames).toHaveLength(1);
  controller.start(connection);
  receive({ ...old, status: { ...status, branch: "old-subscription" } });
  expect(controller.getSnapshot()).toEqual({ kind: "ready", status });
  receive({ ...snapshot(frames.at(-1)!.id), status: { ...status, branch: "reconnected" } });
  expect(controller.getSnapshot()).toMatchObject({ kind: "ready", status: { branch: "reconnected" } });
});
test("reset 或退出立即清空；断线后真实换会话也不保留旧快照", () => {
  const { controller, connection, snapshot, receive, frames } = setup();
  receive(snapshot());
  controller.disconnect(false);
  expect(controller.getSnapshot()).toEqual({ kind: "offline" });
  controller.start(connection);
  expect(controller.getSnapshot()).toEqual({ kind: "loading" });
  receive(snapshot(frames.at(-1)!.id));
  controller.disconnect();
  controller.start({ ...connection, sessionId: "another-session" });
  expect(controller.getSnapshot()).toEqual({ kind: "loading" });
});
test("隐藏期间换会话清空旧数值；没有 ready 的断开状态不显示 loading", () => {
  const { controller, connection, snapshot, receive } = setup();
  receive(snapshot());
  controller.setVisible(false);
  controller.start({ ...connection, sessionId: "another-session" });
  expect(controller.getSnapshot()).toEqual({ kind: "loading" });
  controller.disconnect();
  controller.setVisible(true);
  expect(controller.getSnapshot()).toEqual({ kind: "offline" });
});
test("已确认订阅的重复首帧不覆盖较新的推送", () => {
  const { controller, snapshot, receive } = setup();
  const first = snapshot();
  receive(first);
  receive({ ...first, in_reply_to: undefined, status: { ...status, branch: "newer" } });
  receive(first);
  expect(controller.getSnapshot()).toMatchObject({ kind: "ready", status: { branch: "newer" } });
});
test("普通追加不重订阅，主动 ping 和租约恢复订阅读取动态当前 leaf", () => {
  const { controller, connection, snapshot, receive, frames } = setup();
  let leafId = "ready-tip";
  controller.start({ ...connection, get leafId() { return leafId; } });
  const firstId = frames.at(-1)!.id;
  receive(snapshot(firstId));
  leafId = "appended-tip";
  expect(frames.filter(frame => frame.type === "session_status_subscribe")).toHaveLength(2);
  vi.advanceTimersByTime(SESSION_STATUS_KEEPALIVE_MS);
  expect(frames.at(-1)).toMatchObject({ type: "ping", leaf_id: "appended-tip" });
  leafId = "latest-tip";
  vi.advanceTimersByTime(SESSION_STATUS_KEEPALIVE_MS);
  expect(frames.at(-1)).toMatchObject({ type: "session_status_subscribe", leaf_id: "latest-tip" });
  // 回复仍可引用旧 tip，不用快照的叶节点过滤当前订阅。
  receive(snapshot(frames.at(-1)!.id));
  expect(controller.getSnapshot().kind).toBe("ready");
});
test("旧版错误局部消费，同一 ready 前后台不重试；其他错误和超时拒绝迟到快照", () => {
  const { controller, connection, snapshot, receive, frames } = setup();
  expect(receive({ protocol_version: 2, type: "protocol_error", in_reply_to: frames[0].id, code: "protocol_upgrade_required", message: "synthetic" })).toBe(true);
  expect(controller.getSnapshot()).toEqual({ kind: "unsupported" });
  controller.setVisible(false); controller.setVisible(true);
  expect(frames).toHaveLength(1);
  controller.start(connection);
  const late = snapshot(frames.at(-1)!.id);
  vi.advanceTimersByTime(SESSION_STATUS_REQUEST_TIMEOUT_MS);
  receive(late);
  expect(controller.getSnapshot()).toEqual({ kind: "unavailable" });
  expect(receive({ protocol_version: 2, type: "protocol_error", in_reply_to: "unrelated", code: "internal_error", message: "synthetic" })).toBe(false);
});
test("发送失败不改变主会话，隐藏不心跳，恢复前台获取新首份", () => {
  const { controller, connection, receive, snapshot, frames } = setup();
  receive(snapshot()); controller.setVisible(false);
  vi.advanceTimersByTime(60_000);
  expect(frames).toHaveLength(1);
  controller.setVisible(true);
  expect(frames.at(-1)?.type).toBe("session_status_subscribe");
  controller.start({ ...connection, send: () => false });
  expect(controller.getSnapshot()).toEqual({ kind: "unavailable" });
});
test("心跳超时仅重订阅一次，第二次失败停止；迟到 pong 不恢复", () => {
  const { controller, frames, receive, snapshot } = setup();
  receive(snapshot());
  vi.advanceTimersByTime(SESSION_STATUS_KEEPALIVE_MS);
  const ping = frames.at(-1)!;
  expect(ping.type).toBe("ping");
  vi.advanceTimersByTime(SESSION_STATUS_KEEPALIVE_MS);
  expect(frames.at(-1)?.type).toBe("session_status_subscribe");
  receive({ protocol_version: 2, type: "pong", target_channel_id: "channel", in_reply_to: ping.id });
  vi.advanceTimersByTime(SESSION_STATUS_REQUEST_TIMEOUT_MS * 4);
  expect(controller.getSnapshot()).toEqual({ kind: "unavailable" });
  expect(frames.filter(frame => frame.type === "session_status_subscribe")).toHaveLength(2);
});
test("工具详情与状态共用心跳，pong 按发送时刻续租且仍交工具详情消费", () => {
  const { controller, connection, frames, receive, snapshot } = setup();
  receive(snapshot());
  vi.advanceTimersByTime(SESSION_STATUS_KEEPALIVE_MS);
  const ping = frames.at(-1)!;
  const toolPing: ClientFrame = { protocol_version: 2, type: "ping", id: "tool-details:ping", channel_id: "channel", session_id: "session", leaf_id: "leaf" };
  controller.send(toolPing, connection.origin, connection.send);
  expect(frames.filter(frame => frame.type === "ping")).toHaveLength(1);
  receive({ protocol_version: 2, type: "pong", target_channel_id: "channel", in_reply_to: ping.id });
  vi.advanceTimersByTime(SESSION_STATUS_KEEPALIVE_MS - 1);
  expect(frames.filter(frame => frame.type === "ping")).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(frames.filter(frame => frame.type === "ping")).toHaveLength(2);
});
