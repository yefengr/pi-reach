/**
 * 连接问题在输入区提示行与主区空态中的呈现（ADR-20261105）：短暂抖动不提示，
 * 断线 3 秒后只说明正在重连，10 秒后说明原因并提供立即重试；无网络时重试没有意义，只说明原因。
 */
export type ConnectionIssueKind = "relay" | "network";
export type ConnectionHintStage = "reconnecting" | "retry";

/** 集成测试与 README 截图可调短。 */
export const CONNECTION_HINT_TIMING = { reconnectingMs: 3_000, retryMs: 10_000 };

export type ConnectionHintMessages = {
  /** 断线 3 秒后：只有动态图标，不提供操作。 */
  reconnecting: string;
  /** 断线 10 秒后仍在自动重试。 */
  relayAutoRetrying: string;
  /** 自动重试已停止，需要用户重试。 */
  unavailable: string;
  /** 无网络：恢复后自动重连。 */
  networkWaiting: string;
};

export type ConnectionHintView = { text: string; busy: boolean; retry: boolean };

/**
 * busy 表示仍在连接或自动重试，决定文案与动态图标；stage 为 null 时还在短暂抖动的宽限期内，不提示。
 */
export function connectionHint(kind: ConnectionIssueKind | null, stage: ConnectionHintStage | null, busy: boolean, messages: ConnectionHintMessages): ConnectionHintView | null {
  if (kind === null || stage === null) return null;
  if (kind === "network") return { text: messages.networkWaiting, busy: false, retry: false };
  if (stage === "reconnecting") return { text: messages.reconnecting, busy: true, retry: false };
  return { text: busy ? messages.relayAutoRetrying : messages.unavailable, busy, retry: true };
}
