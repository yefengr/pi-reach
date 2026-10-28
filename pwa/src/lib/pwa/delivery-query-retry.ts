/** 状态查询超时、未收到任何答复后的自动重查间隔；用尽后只保留手动「核对」。 */
export const DELIVERY_STATUS_RETRY_DELAYS_MS = [15_000, 45_000] as const;

/**
 * 同一发送尝试与队列操作下连续查询超时的进度。只有「无答复」才重查：弱状态、否定结果和查询错误
 * 都是答复，由调用方清除记录，避免对同一消息无限查询。
 */
export type DeliveryQueryRetry = {
  readonly attempt: string;
  readonly operation: string | undefined;
  readonly timeouts: number;
  /** null 表示自动重查已用尽。 */
  readonly retryAt: number | null;
};

export function recordDeliveryQueryTimeout(
  previous: DeliveryQueryRetry | undefined,
  attempt: string,
  operation: string | undefined,
  now: number,
): DeliveryQueryRetry {
  const sameTarget = previous !== undefined && previous.attempt === attempt && previous.operation === operation;
  const timeouts = sameTarget ? previous.timeouts + 1 : 1;
  const delay = DELIVERY_STATUS_RETRY_DELAYS_MS[timeouts - 1];
  return { attempt, operation, timeouts, retryAt: delay === undefined ? null : now + delay };
}

/** 记录只对产生它的发送尝试与队列操作有效；新尝试从首次查询重新计。 */
export function deliveryQueryRetryAt(
  retry: DeliveryQueryRetry | undefined,
  attempt: string,
  operation: string | undefined,
): number | null {
  if (!retry || retry.attempt !== attempt || retry.operation !== operation) return null;
  return retry.retryAt;
}
