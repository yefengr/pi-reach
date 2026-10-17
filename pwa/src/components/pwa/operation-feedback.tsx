import { CircleHelp, LoaderCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { PendingSessionAction, PendingStop } from "@/lib/pwa/operation-feedback";
import "./operation-feedback.css";

export type CompactionActivity = { sessionId: string; status: "running" | "completed" | "failed" | "cancelled" | "unknown" };

export function OperationFeedback({ pending, stop, compaction }: { pending: PendingSessionAction | null; stop: PendingStop | null; compaction: CompactionActivity | null }) {
  const { t } = useI18n();
  const f = t.operationFeedback;
  const unknown = pending?.phase === "unknown" || stop?.unknown === true || !pending && compaction?.status === "unknown";
  const busy = !unknown && (!!stop || pending?.action === "session_new" || pending?.action === "session_compact" || !pending && compaction?.status === "running");
  const unknownLabel = stop?.unknown ? f.stopUnknown : pending?.action === "session_new" ? f.newUnknown
    : pending?.action === "model_set" || pending?.action === "thinking_set" ? f.configUnknown : f.unknown;
  const label = unknown ? unknownLabel : stop ? stop.accepted ? f.stopAccepted : f.requestingStop : pending?.action === "session_new"
    ? pending.targetSessionId ? f.openingSession : f.creatingSession
    : pending?.action === "session_compact" || compaction?.status === "running" ? f.compacting
      : compaction?.status === "cancelled" ? f.compactCancelled : compaction?.status === "failed" ? f.compactFailed : null;
  if (!label) return null;
  return <div className="pwa-operation-status" data-unknown={unknown || !busy && compaction?.status === "cancelled" || undefined} data-failed={!pending && compaction?.status === "failed" || undefined} role="status">
    {busy ? <LoaderCircle className="pwa-spin" size={16} aria-hidden="true" /> : unknown ? <CircleHelp size={16} aria-hidden="true" /> : null}
    <span>{label}</span>
  </div>;
}
