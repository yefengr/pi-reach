import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ServerFrame } from "../protocol/v2/index.js";

type ChannelScope = { sessionId: string; leafId: string | null; valid: boolean };
type RequestScope = { sessionId?: string; leafId?: string | null };
type InvalidReason = "session_replaced" | "branch_changed";

/** 请求可引用 hello 后的同分支祖先；历史快照仍由 pager 独立严格校验。 */
export class TimelineRequestScope {
  private readonly channels = new Map<string, ChannelScope>();

  constructor(private readonly sessionManager: SessionManager) {}

  hello(channelId: string): void {
    this.channels.set(channelId, {
      sessionId: this.sessionManager.getSessionId(),
      leafId: this.sessionManager.getLeafId() ?? null,
      valid: true,
    });
  }

  invalidate(): void {
    // 显式切换即使回到同一叶，也不能重新放行旧 channel 的迟到请求。
    for (const scope of this.channels.values()) scope.valid = false;
  }

  resetFrame(channelId: string, reason: InvalidReason): ServerFrame {
    return {
      protocol_version: 2,
      type: "reset",
      target_channel_id: channelId,
      session_id: this.sessionManager.getSessionId(),
      leaf_id: this.sessionManager.getLeafId() ?? null,
      reason,
    };
  }

  invalidReason(channelId: string, request: RequestScope): InvalidReason | null {
    const scope = this.channels.get(channelId);
    const sessionId = this.sessionManager.getSessionId();
    if ((request.sessionId !== undefined && request.sessionId !== sessionId)
      || (scope && scope.sessionId !== sessionId)) return "session_replaced";
    if (!scope?.valid) return "branch_changed";

    const leafId = this.sessionManager.getLeafId() ?? null;
    const requestedLeaf = request.leafId === undefined ? leafId : request.leafId;
    if (leafId === scope.leafId) return requestedLeaf === leafId ? null : "branch_changed";

    // 仅回溯 hello 后的增量，不为每个请求扫描完整历史分支。
    const ancestors = new Set<string | null>([scope.leafId]);
    let current = leafId;
    while (current !== scope.leafId && current !== null) {
      if (ancestors.has(current)) return "branch_changed";
      const entry = this.sessionManager.getEntry(current);
      if (!entry) return "branch_changed";
      ancestors.add(current);
      current = entry.parentId;
    }
    return current === scope.leafId && ancestors.has(requestedLeaf) ? null : "branch_changed";
  }
}
