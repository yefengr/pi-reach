import type { ServerFrame, V2IdempotencyRecord } from "../protocol/v2/index.js";

/** 单次握手最多补推的投递确认条数；超出部分仍由 PWA 的状态查询补回。 */
export const MAX_RECEIPT_REPLAY = 32;

export type ReceiptReplayScope = {
  senderRef: string;
  channelId: string;
  sessionId: string;
  leafId: string | null;
};

/**
 * 同一 channel 重新握手时，补发断线期间可能丢失的「已开始」确认。Relay 不缓存定向帧，
 * PWA 断线时发出的 started／accepted 会直接丢失。
 *
 * 只补带 message_id 的肯定证据，`in_reply_to` 沿用原发送尝试，PWA 按原请求关联；committed 也按
 * accepted 补发，最终以正式事件为准。PWA 回报已看到正式消息后记录即被遗忘，不再补推。
 */
export function receiptReplayFrames(
  records: readonly V2IdempotencyRecord[],
  scope: ReceiptReplayScope,
  channelOf: (clientRequestId: string) => string | undefined,
): ServerFrame[] {
  const frames: ServerFrame[] = [];
  // 记录按最近使用排序；容量不足时优先补最近的消息。
  for (const record of [...records].reverse()) {
    if (frames.length >= MAX_RECEIPT_REPLAY) break;
    if (record.senderRef !== scope.senderRef || (record.status !== "accepted" && record.status !== "committed")
      || !record.messageId || !record.attemptId || channelOf(record.clientRequestId) !== scope.channelId) continue;
    frames.push({
      protocol_version: 2,
      type: "user_message_status",
      target_channel_id: scope.channelId,
      in_reply_to: record.attemptId,
      session_id: scope.sessionId,
      leaf_id: scope.leafId,
      client_request_id: record.clientRequestId,
      status: "accepted",
      message_id: record.messageId,
      ...(record.groupId ? { group_id: record.groupId } : {}),
    });
  }
  return frames;
}
