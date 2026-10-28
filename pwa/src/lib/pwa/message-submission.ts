import type { AttachmentDescriptor } from "../pi-reach/protocol-v2/schema";
import { encodeClientFrameV2 } from "../pi-reach/protocol-v2";
import type { PeerChannel } from "../pi-reach/peer-channel";
import { type TimelineRuntime, type TimelineRuntimeChange, type TimelineScope } from "./timeline-runtime";
import type { OwnSendCapture } from "./use-timeline-viewport";
import type { AttachmentCapability } from "./attachment-upload-types";

export type SubmitOutcome = "not-handled" | "handled";
export type AttachmentLease = { target: string; uploadScope: string };
/** retry：可按原附件 ID 重试；wait：能力仍在校验，暂不写终态；invalid：原目标、能力或租约已确定失效。 */
export type AttachmentRetryDecision = "retry" | "wait" | "invalid";

/**
 * 附件消息明确失败后的重试前置判定：只有当前目标、能力已就绪且全部附件仍属交接时的租约才可重试。
 * 目标已变、目标不支持附件或租约缺失／变化才是确定失效；校验中只等待，不能把暂态写成不可重试。
 */
export function attachmentRetryDecision(input: {
  attachments: readonly AttachmentDescriptor[];
  target: string;
  composer: { target: string | null; capability: AttachmentCapability };
  leases: ReadonlyMap<string, AttachmentLease>;
}): AttachmentRetryDecision {
  const { composer, target } = input;
  if (composer.target !== target || composer.capability.status === "unsupported") return "invalid";
  if (composer.capability.status !== "supported") return "wait";
  return input.attachments.every((item) => {
    const lease = input.leases.get(item.attachment_id);
    return lease?.target === target && lease.uploadScope === composer.capability.uploadScope;
  }) ? "retry" : "invalid";
}

/** 建立 pending 即完成草稿所有权交接；transport 失败仍由原消息承担恢复。 */
export function submitMessage(input: {
  text: string;
  attachments?: readonly AttachmentDescriptor[];
  scope: TimelineScope | null;
  channel: PeerChannel | null;
  online: boolean;
  historyOpen: boolean;
  newSessionPending: boolean;
  runtime: TimelineRuntime;
  /** Pi 正在运行：消息预计进入队列，直接显示在排队区，不进入对话区。 */
  queueExpected?: boolean;
  /** 当前是否仍在跟随最新输出；预计排队的消息不进入对话区，回看时不为它恢复跟随。 */
  following?: () => boolean;
  capture: () => OwnSendCapture | null;
  follow: (capture: OwnSendCapture | null) => void;
  apply: (change: TimelineRuntimeChange) => void;
  /** 建立消息前的同步失败由调用方转成输入区错误；不得把它当成已接管。 */
  onPrepareError?: (error: unknown) => void;
}): SubmitOutcome {
  const { scope, channel, runtime } = input;
  const current = runtime.currentScope;
  if (!scope || !current || !channel || channel.closed || !input.online || input.historyOpen || input.newSessionPending
    || scope.deviceId !== current.deviceId || scope.endpointId !== current.endpointId
    || scope.runtimeInstanceId !== current.runtimeInstanceId || scope.sessionId !== current.sessionId
    || scope.selfSenderRef !== current.selfSenderRef || scope.channelId !== current.channelId
    || channel.channelId !== scope.channelId) return "not-handled";
  const capture = input.capture();
  let prepared;
  try {
    prepared = input.attachments?.length
      ? runtime.sendUserWithAttachments(input.text, input.attachments, undefined, { queueExpected: input.queueExpected })
      : runtime.sendUser(input.text, undefined, undefined, { queueExpected: input.queueExpected });
  } catch (error) {
    input.onPrepareError?.(error);
    return "not-handled";
  }
  if (!prepared) return "not-handled";
  // wire 编码失败是确定性的内容错误，不是可重试的传输失败；回滚刚建立的 pending 并保留草稿。
  try {
    encodeClientFrameV2(prepared.frame);
  } catch (error) {
    input.apply(runtime.discardPending(prepared.frame.client_request_id));
    input.onPrepareError?.({ invalidPayload: true, cause: error });
    return "not-handled";
  }
  input.apply(prepared.change);
  if (!channel.send(prepared.frame)) {
    input.apply(runtime.markDeliveryFailed(prepared.frame.client_request_id, "transport_unavailable", true));
    return "handled";
  }
  if (!input.queueExpected || input.following?.() !== false) input.follow(capture);
  return "handled";
}
