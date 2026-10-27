import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";

export const FIXTURE = {
  deviceId: "ab-device",
  endpointId: "ab-endpoint",
  runtimeInstanceId: "ab-runtime",
  sessionId: "ab-session",
  leafId: "ab-leaf",
  senderRef: "ab-sender",
  relayUrl: "https://relay.invalid",
  timestamp: 1_790_000_000_000,
} as const;

export function historyCountFromUrl(): number {
  const value = new URLSearchParams(window.location.search).get("history") ?? "0";
  if (!["0", "60", "300"].includes(value)) throw new Error("Unsupported fixture history count");
  return Number(value);
}

export function createHistory(count: number): TimelineEvent[] {
  const paragraph = "Pi Reach fixed history content: deterministic Markdown for production rendering, layout and persistence. ";
  return Array.from({ length: count }, (_, index): TimelineEvent => {
    const sequence = index + 1;
    const text = `## History ${sequence}\n\n${paragraph.repeat(9)}\n\n\`\`\`ts\nconst value = ${sequence};\n\`\`\`\n\n| Field | Value |\n| --- | --- |\n| record | ${sequence} |\n\nHistory record complete.\n`;
    return {
      event_id: `history-${sequence}`,
      event_seq: sequence,
      session_id: FIXTURE.sessionId,
      leaf_id: FIXTURE.leafId,
      timestamp: FIXTURE.timestamp + sequence,
      group_id: `history-group-${sequence}`,
      kind: "assistant",
      status: "complete",
      blocks: [{ type: "text", text }],
    };
  });
}
