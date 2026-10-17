import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import type { Messages } from "@/lib/i18n";

export type SummaryEvent = Extract<TimelineEvent, { kind: "provider_error" }>
  | (Extract<TimelineEvent, { payload: unknown }> & { kind: "compaction" | "branch_summary" });

export function isSummaryEvent(event: TimelineEvent): event is SummaryEvent {
  return event.kind === "compaction" || event.kind === "branch_summary" || event.kind === "provider_error";
}

/** 只读取正式正文，不把 details、内部标识或整个 payload 当成摘要。 */
export function summaryText(payload: unknown): string | null {
  const value = typeof payload === "string" ? payload
    : payload !== null && typeof payload === "object" && "summary" in payload ? payload.summary : null;
  return typeof value === "string" && value.trim() ? value : null;
}

export function summaryPresentation(event: SummaryEvent, t: Messages["summaryReader"]) {
  if (event.kind === "provider_error") {
    // message 没有可靠的字段筛选契约；不展示、复制或从字符串推断状态码和原因。
    return { title: t.providerError, text: `${t.errorExplanation}\n\n${t.recoveryAdvice}`, error: true };
  }
  return {
    title: event.kind === "compaction" ? t.compaction : t.branchSummary,
    text: summaryText(event.payload) ?? t.unavailable,
    error: false,
  };
}
