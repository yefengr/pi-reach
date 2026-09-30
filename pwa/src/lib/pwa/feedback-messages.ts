import type { Locale } from "@/lib/i18n";

export type FeedbackSource = "general" | "history" | "timeline" | "pairing" | "image" | "message-send" | "protocol" | "local-history";

const fallbackMessages: Record<FeedbackSource, string> = {
  general: "Something went wrong. Try again.",
  history: "Could not load the conversation. Try again.",
  timeline: "Could not update the conversation. Reconnect and try again.",
  pairing: "Could not pair with Pi. Check the code and try again.",
  image: "Could not prepare that image. Choose another image and try again.",
  "message-send": "Could not send this message. Try again.",
  protocol: "Pi could not process this request. Try again.",
  "local-history": "Could not update local history.",
};

const protocolErrorMessages: Record<string, string> = {
  invalid_channel: "This session is out of date. Reconnect and try again.",
  reset_required: "This session is out of date. Reconnect and try again.",
  invalid_leaf: "This session is out of date. Reconnect and try again.",
  too_large: "This message is too large to send.",
  unsupported_type: "This operation is not supported. Update Pi and try again.",
  invalid_message: "Pi rejected this message. Check it and try again.",
};

// 只保留明确的产品文案，异常字符串不能通过关键词匹配进入界面。
const messageReplacements: Record<string, string> = {
  "Relay is not connected.": "Message could not be sent. Check the connection and try again.",
  "The Pi extension must be updated to load numbered events.": "Could not read this conversation. Update Pi and try again.",
  "Local timeline changed unexpectedly.": "This conversation changed elsewhere. Reconnect and try again.",
  "Enter an 8-character Crockford Base32 pairing code, such as K7MP-4Q2D.": "Enter the 8-character pairing code from Pi.",
  "That pairing target is no longer available. Generate a new code on the Pi.": "Pi is no longer available for pairing. Generate a new code on Pi.",
  "This browser cannot prepare image attachments.": "Could not prepare that image. Choose another image and try again.",
};

const safeMessages = new Set([
  ...Object.values(fallbackMessages),
  ...Object.values(messageReplacements),
  ...Object.values(protocolErrorMessages),
  "Too many unconfirmed messages or attachments. Wait for delivery confirmation before sending more.",
  "Too many queued messages or attachments. Existing messages were kept. Reconnect after the queue gets smaller.",
  "Could not read saved conversations.",
  "Could not read the saved conversation.",
  "Could not update local history.",
  "Could not load earlier history.",
  "Could not prepare image.",
  "Could not use that image.",
  "Choose a PNG, JPEG, or WebP image.",
  "Message text is too large to send with an image.",
  "Could not read that image.",
  "Could not prepare that image.",
  "Could not encode that image.",
  "This transparent PNG is too large to send.",
  "This PNG is too large to send.",
  "This image is too large to send.",
  "That pairing code was not found. Check the code and try again.",
  "That pairing code has expired. Generate a new code on the Pi.",
  "Too many pairing attempts. Wait a moment and try again.",
  "Pairing timed out. Generate a fresh pairing code on the Pi.",
  "Could not read this QR code.",
  "Camera access was unavailable. Use an image instead.",
  "No Pi Reach QR code was found in that image.",
  "Could not complete this action. Try again.",
  "Could not start a fresh session. Check the connection and try again.",
  "Could not delete pairing. Try again.",
  "Could not clear local data. Try again.",
]);

export function safeFeedbackMessage(message: string | null | undefined, source: FeedbackSource = "general"): string | null {
  if (!message) return null;
  if (Object.hasOwn(messageReplacements, message)) return messageReplacements[message];
  return safeMessages.has(message) ? message : fallbackMessages[source];
}

export function safeProtocolFeedbackMessage(code: string): string {
  return Object.hasOwn(protocolErrorMessages, code) ? protocolErrorMessages[code] : fallbackMessages.protocol;
}

export function safeConfirmationError(kind: "new-session" | "remove-pairing" | "clear-local-data"): string {
  if (kind === "new-session") return "Could not start a fresh session. Check the connection and try again.";
  if (kind === "remove-pairing") return "Could not delete pairing. Try again.";
  return "Could not clear local data. Try again.";
}

// 安全文案以英文原文作为内部标识，展示时按界面语言替换；测试保证每条安全文案都有中文。
const zhFeedback: Record<string, string> = {
  "Something went wrong. Try again.": "出了点问题，请重试。",
  "Could not load the conversation. Try again.": "无法加载会话，请重试。",
  "Could not update the conversation. Reconnect and try again.": "无法更新会话，请重新连接后重试。",
  "Could not pair with Pi. Check the code and try again.": "无法与 Pi 配对，请核对配对码后重试。",
  "Could not prepare that image. Choose another image and try again.": "无法处理这张图片，请换一张后重试。",
  "Could not send this message. Try again.": "无法发送这条消息，请重试。",
  "Pi could not process this request. Try again.": "Pi 无法处理这个请求，请重试。",
  "Could not update local history.": "无法更新本地历史。",
  "This session is out of date. Reconnect and try again.": "当前会话已过期，请重新连接后重试。",
  "This message is too large to send.": "这条消息太大，无法发送。",
  "This operation is not supported. Update Pi and try again.": "不支持此操作，请更新 Pi 后重试。",
  "Pi rejected this message. Check it and try again.": "Pi 拒绝了这条消息，请检查后重试。",
  "Message could not be sent. Check the connection and try again.": "消息未能发送，请检查连接后重试。",
  "Could not read this conversation. Update Pi and try again.": "无法读取这个会话，请更新 Pi 后重试。",
  "This conversation changed elsewhere. Reconnect and try again.": "这个会话已在别处变更，请重新连接后重试。",
  "Enter the 8-character pairing code from Pi.": "请输入 Pi 显示的 8 位配对码。",
  "Pi is no longer available for pairing. Generate a new code on Pi.": "这个 Pi 已无法配对，请在 Pi 中重新生成配对码。",
  "Too many unconfirmed messages or attachments. Wait for delivery confirmation before sending more.": "未确认的消息或附件过多，请等待送达确认后再发送。",
  "Too many queued messages or attachments. Existing messages were kept. Reconnect after the queue gets smaller.": "排队的消息或附件过多，已有消息已保留。请在队列变短后重新连接。",
  "Could not read saved conversations.": "无法读取已保存的会话。",
  "Could not read the saved conversation.": "无法读取已保存的会话。",
  "Could not load earlier history.": "无法加载更早的记录。",
  "Could not prepare image.": "无法处理图片。",
  "Could not use that image.": "无法使用这张图片。",
  "Choose a PNG, JPEG, or WebP image.": "请选择 PNG、JPEG 或 WebP 图片。",
  "Message text is too large to send with an image.": "消息文字过长，无法与图片一起发送。",
  "Could not read that image.": "无法读取这张图片。",
  "Could not prepare that image.": "无法处理这张图片。",
  "Could not encode that image.": "无法编码这张图片。",
  "This transparent PNG is too large to send.": "这张透明 PNG 太大，无法发送。",
  "This PNG is too large to send.": "这张 PNG 太大，无法发送。",
  "This image is too large to send.": "这张图片太大，无法发送。",
  "That pairing code was not found. Check the code and try again.": "配对码无效，请核对后重试。",
  "That pairing code has expired. Generate a new code on the Pi.": "配对码已过期，请在 Pi 中重新生成。",
  "Too many pairing attempts. Wait a moment and try again.": "尝试次数过多，请稍后再试。",
  "Pairing timed out. Generate a fresh pairing code on the Pi.": "配对超时，请在 Pi 中重新生成配对码。",
  "Could not read this QR code.": "无法识别这个二维码。",
  "Camera access was unavailable. Use an image instead.": "无法使用摄像头，请改用图片。",
  "No Pi Reach QR code was found in that image.": "图片中没有找到 Pi Reach 二维码。",
  "Could not complete this action. Try again.": "无法完成此操作，请重试。",
  "Could not start a fresh session. Check the connection and try again.": "无法开始新会话，请检查连接后重试。",
  "Could not delete pairing. Try again.": "无法删除配对，请重试。",
  "Could not clear local data. Try again.": "无法清除本地数据，请重试。",
};

export function localizeFeedback(message: string, locale: Locale): string {
  return locale === "zh-CN" ? zhFeedback[message] ?? message : message;
}

/** 供测试核对译文覆盖：所有可能展示的安全文案。 */
export function safeFeedbackCatalog(): string[] {
  return [...safeMessages];
}
