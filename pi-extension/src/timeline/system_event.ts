import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { TimelineEventSchema, type TimelineEvent } from "../protocol/v2/index.js";
import { jsonValue } from "./tool_lifecycle.js";
import { PUBLISHED_FILE_TYPE } from "@pi-reach/protocol/session";
import type { ConfirmedPublication } from "../files/publications.js";

type SessionEntry = ReturnType<SessionManager["getBranch"]>[number];

/** 系统记录的实时和历史投影共用同一入口。 */
export function systemTimelineEvent(entry: SessionEntry, manager: SessionManager, timestamp: number, markerType: string, publication?: ConfirmedPublication): TimelineEvent | null {
  const base = {
    event_id: entry.id,
    session_id: manager.getSessionId(),
    leaf_id: manager.getLeafId() ?? null,
    timestamp,
    truncated: false,
  };
  let candidate: unknown;
  if (entry.type === "compaction") {
    candidate = {
      ...base, kind: "compaction",
      payload: {
        summary: entry.summary,
        first_kept_entry_id: entry.firstKeptEntryId,
        tokens_before: entry.tokensBefore,
        from_hook: entry.fromHook ?? false,
        ...(entry.details === undefined ? {} : { details: jsonValue(entry.details) }),
      },
    };
  } else if (entry.type === "branch_summary") {
    candidate = {
      ...base, kind: "branch_summary",
      payload: {
        summary: entry.summary,
        from_id: entry.fromId,
        from_hook: entry.fromHook ?? false,
        ...(entry.details === undefined ? {} : { details: jsonValue(entry.details) }),
      },
    };
  } else if (entry.type === "custom" && entry.customType === PUBLISHED_FILE_TYPE) {
    if (!publication) return null;
    candidate = {
      ...base, kind: "custom",
      ...(publication.groupId ? { group_id: publication.groupId } : {}),
      payload: { custom_type: PUBLISHED_FILE_TYPE, data: publication.metadata },
    };
  } else if (entry.type === "custom" && entry.customType !== markerType) {
    candidate = {
      ...base, kind: "custom",
      payload: { custom_type: entry.customType, ...(entry.data === undefined ? {} : { data: jsonValue(entry.data) }) },
    };
  } else { return null; }
  const parsed = TimelineEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
