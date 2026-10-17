import { CircleHelp, LoaderCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { PendingSessionAction } from "@/lib/pwa/operation-feedback";
import "./operation-feedback.css";

export type CompactionActivity = { sessionId: string; status: "running" | "completed" | "failed" | "cancelled" | "unknown" };

export function OperationFeedback({ pending, stopUnknown, compaction }: { pending: PendingSessionAction | null; stopUnknown: boolean; compaction: CompactionActivity | null }) {
  const { t } = useI18n();
  const f = t.operationFeedback;
  const unknown = pending?.phase === "unknown" || stopUnknown || !pending && compaction?.status === "unknown";
  const busy = !unknown && (pending?.action === "session_new" || pending?.action === "session_compact" || !pending && compaction?.status === "running");
  const label = unknown ? f.unknown : pending?.action === "session_new"
    ? pending.targetSessionId ? f.openingSession : f.creatingSession
    : pending?.action === "session_compact" || compaction?.status === "running" ? f.compacting
      : compaction?.status === "cancelled" ? f.compactCancelled : compaction?.status === "failed" ? f.compactFailed : null;
  if (!label) return null;
  return <div className="pwa-operation-status" data-unknown={unknown || !busy && compaction?.status === "cancelled" || undefined} data-failed={!pending && compaction?.status === "failed" || undefined} role="status">
    {busy ? <LoaderCircle className="pwa-spin" size={16} aria-hidden="true" /> : unknown ? <CircleHelp size={16} aria-hidden="true" /> : null}
    <span>{label}</span>
  </div>;
}
