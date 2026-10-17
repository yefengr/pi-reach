import type { ExtensionAPI, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ServerFrame } from "../protocol/v2/index.js";

type ActivityFrame = Extract<ServerFrame, { type: "compaction_activity" }>;

/** Public hooks describe activity only; remote requests are settled by their own callbacks. */
export function registerCompactionActivity(
  pi: ExtensionAPI,
  broadcast: (frame: ActivityFrame) => void,
  publish: (entry: SessionEntry, manager: SessionManager) => void,
): void {
  type Scope = Pick<ActivityFrame, "session_id" | "leaf_id">;
  const started = new Map<string, Map<ActivityFrame["reason"], Scope>>();
  const emit = (status: ActivityFrame["status"], reason: ActivityFrame["reason"], manager: { getSessionId(): string; getLeafId(): string | null }): void => {
    const sessionId = manager.getSessionId();
    let scope: Scope = { session_id: sessionId, leaf_id: manager.getLeafId() ?? null };
    if (status === "running") {
      let session = started.get(sessionId);
      if (!session) started.set(sessionId, session = new Map());
      session.set(reason, scope);
    } else {
      const session = started.get(sessionId);
      // SDK appendCompaction 已改变 leaf；终态必须先关闭开始时的活动，再发布新 leaf 的摘要。
      scope = session?.get(reason) ?? scope;
      session?.delete(reason);
      if (session?.size === 0) started.delete(sessionId);
    }
    broadcast({ protocol_version: 2, type: "compaction_activity", ...scope, status, reason });
  };
  pi.on("session_before_compact", (event, ctx) => {
    emit("running", event.reason, ctx.sessionManager);
  });
  pi.on("session_compact", (event, ctx) => {
    emit("completed", event.reason, ctx.sessionManager);
    publish(event.compactionEntry, ctx.sessionManager as SessionManager);
  });
  pi.on("session_compact_failed", (event, ctx) => {
    emit(event.aborted ? "cancelled" : "failed", event.reason, ctx.sessionManager);
  });
}
