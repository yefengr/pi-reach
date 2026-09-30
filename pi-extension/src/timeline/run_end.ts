import { MarkerSchemaV2, TimelineEventSchema, type MarkerV2, type TimelineEvent } from "../protocol/v2/index.js";

export type RunEndStatus = "complete" | "interrupted" | "error";
export type RunEndMarker = Extract<MarkerV2, { kind: "run_end" }>;

/** 以本次运行最后一条 assistant 消息的 stopReason 决定结束状态；没有 assistant 输出即视为被中断。 */
export function runEndStatus(messages: readonly unknown[] | undefined): RunEndStatus {
  const assistant = [...(messages ?? [])].reverse().find((message): message is { role: "assistant"; stopReason?: unknown } =>
    typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant");
  if (!assistant) return "interrupted";
  if (assistant.stopReason === "error") return "error";
  if (assistant.stopReason === "aborted") return "interrupted";
  return "complete";
}

export function runEndMarker(groupId: string, status: RunEndStatus): RunEndMarker {
  return MarkerSchemaV2.parse({ version: 2, group_id: groupId, kind: "run_end", status }) as RunEndMarker;
}

export function isRunEndMarker(marker: MarkerV2): marker is RunEndMarker {
  return marker.kind === "run_end";
}

/** run_end 没有对应的 Pi 消息，marker 条目本身就是正式事件，时间取条目写入时间。 */
export function runEndEvent(
  marker: RunEndMarker,
  base: { event_id: string; session_id: string; leaf_id: string | null; timestamp: number },
): TimelineEvent {
  return TimelineEventSchema.parse({ ...base, group_id: marker.group_id, kind: "run_end", status: marker.status });
}
