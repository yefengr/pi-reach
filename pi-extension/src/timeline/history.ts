import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  encodeServerFrameV2,
  getUtf8ByteLengthV2,
  MAX_FRAGMENT_DECODE_BYTES,
  MAX_HISTORY_CHUNK_BYTES,
  MAX_WINDOW_DECODE_BYTES,
  TimelineEventSchema,
  type ServerFrame,
  type TimelineEvent,
} from "../protocol/v2/index.js";

const DEFAULT_EVENTS_PER_PAGE = 80;
type RecoveryFn = (sessionManager: SessionManager) => readonly TimelineEvent[];
type HistorySyncRequest = { requestId: string; targetChannelId: string; leafId: string | null; before: number | null; limit?: number };
type Snapshot = { sessionId: string; leafId: string | null; branchEntryIds: readonly string[] };
type EventRecord = { event: TimelineEvent & { event_seq: number }; bytes: number };
type HistoryItem = { kind: "event"; event: TimelineEvent } | { kind: "fragment"; eventId: string; index: number; dataBase64: string; final: boolean };
type Payload = { events: TimelineEvent[]; fragments: Array<{ event_id: string; index: number; data_base64: string; final: boolean }> };
export type TimelineHistorySync = HistorySyncRequest;
export type TimelineHistoryRecovery = RecoveryFn;

export class TimelineHistoryPager {
  constructor(private readonly sessionManager: SessionManager, private readonly recoverFn: RecoveryFn) {}

  sync(request: HistorySyncRequest): ServerFrame[] {
    const invalidRequest = this.validateRequest(request);
    if (invalidRequest) return [invalidRequest];
    const snapshot = this.captureSnapshot();
    if (!snapshot) return [this.protocolError(request, "reset_required", "session has no current snapshot head")];
    const initialScopeMismatch = this.snapshotInvalidReason(snapshot, request.leafId);
    if (initialScopeMismatch) return [this.reset(request, initialScopeMismatch)];
    let records: EventRecord[];
    try { records = this.recoverRecords(snapshot); } catch { return [this.protocolError(request, "internal_error", "history recovery failed")]; }
    const changed = this.snapshotInvalidReason(snapshot, request.leafId);
    if (changed) return [this.reset(request, changed)];
    const headSeq = records.length;
    const before = request.before ?? headSeq + 1;
    if (before > headSeq + 1) return [this.protocolError(request, "invalid_cursor", "history boundary is beyond the current head")];
    const window = this.selectWindow(records, before, request.limit ?? DEFAULT_EVENTS_PER_PAGE);
    if (window.kind === "error") return [this.protocolError(request, "too_large", window.message)];
    const nextBefore = window.records[0]?.event.event_seq;
    const eos = window.records.length === 0 || nextBefore === 1;
    try { return this.fragmentWindow(request, snapshot, window.records, eos ? undefined : nextBefore); }
    catch (error) { return [this.protocolError(request, "too_large", error instanceof Error ? error.message : "history chunk construction failed")]; }
  }

  private validateRequest(request: HistorySyncRequest): ServerFrame | null {
    if (request.before !== null && (!Number.isSafeInteger(request.before) || request.before < 1)) return this.protocolError(request, "invalid_cursor", "history boundary must be a positive safe integer or null");
    if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 80)) return this.protocolError(request, "invalid_cursor", "history limit must be an integer from 1 through 80");
    return null;
  }

  private captureSnapshot(): Snapshot | null {
    const sessionId = this.sessionManager.getSessionId();
    const leafId = this.sessionManager.getLeafId() ?? null;
    const branch = this.sessionManager.getBranch();
    if (branch.length > 0 && branch.at(-1)?.id !== leafId) return null;
    return { sessionId, leafId, branchEntryIds: branch.map((entry) => entry.id) };
  }

  private snapshotInvalidReason(snapshot: Snapshot, requestedLeafId: string | null): "session_replaced" | "branch_changed" | null {
    if (this.sessionManager.getSessionId() !== snapshot.sessionId) return "session_replaced";
    if (requestedLeafId !== snapshot.leafId) return "branch_changed";
    const currentLeafId = this.sessionManager.getLeafId() ?? null;
    if (currentLeafId !== snapshot.leafId) return "branch_changed";
    const currentIds = this.sessionManager.getBranch().map((entry) => entry.id);
    if (!sameIds(currentIds, snapshot.branchEntryIds)) return "branch_changed";
    const frozenIds = snapshot.leafId === null ? currentIds : this.sessionManager.getBranch(snapshot.leafId).map((entry) => entry.id);
    return sameIds(frozenIds, snapshot.branchEntryIds) ? null : "branch_changed";
  }

  private recoverRecords(snapshot: Snapshot): EventRecord[] {
    const records: EventRecord[] = [];
    const eventIds = new Set<string>();
    const sequences = new Set<number>();
    for (const rawEvent of this.recoverFn(this.sessionManager)) {
      const parsed = TimelineEventSchema.safeParse(rawEvent);
      if (!parsed.success || parsed.data.event_seq === undefined) throw new Error("recovery returned an unsequenced timeline event");
      const event = parsed.data as TimelineEvent & { event_seq: number };
      if (event.session_id !== snapshot.sessionId || event.leaf_id !== snapshot.leafId) throw new Error("recovery returned an event outside the snapshot scope");
      if (eventIds.has(event.event_id) || sequences.has(event.event_seq)) throw new Error("recovery returned duplicate timeline identity");
      eventIds.add(event.event_id); sequences.add(event.event_seq); records.push({ event, bytes: getUtf8ByteLengthV2(event) });
    }
    records.sort((left, right) => left.event.event_seq - right.event.event_seq);
    if (records.some((record, index) => record.event.event_seq !== index + 1)) throw new Error("recovery returned a non-dense timeline sequence");
    return records;
  }

  private selectWindow(records: readonly EventRecord[], before: number, limit: number): { kind: "ok"; records: EventRecord[] } | { kind: "error"; message: string } {
    const lower = Math.max(1, before - limit);
    const requested = records.filter((record) => record.event.event_seq >= lower && record.event.event_seq < before);
    const selected: EventRecord[] = [];
    let bytes = 0;
    for (let index = requested.length - 1; index >= 0; index -= 1) {
      const record = requested[index]!;
      if (record.bytes > MAX_WINDOW_DECODE_BYTES) return { kind: "error", message: `event ${record.event.event_id} exceeds ${MAX_WINDOW_DECODE_BYTES} bytes` };
      if (bytes + record.bytes > MAX_WINDOW_DECODE_BYTES) break;
      selected.unshift(record); bytes += record.bytes;
    }
    return { kind: "ok", records: selected };
  }

  private fragmentWindow(request: HistorySyncRequest, snapshot: Snapshot, records: readonly EventRecord[], nextBefore: number | undefined): ServerFrame[] {
    const tailOverhead = this.finalFrameBytes(request, snapshot, { events: [], fragments: [] }, nextBefore) - this.nonFinalFrameBytes(request, snapshot, { events: [], fragments: [] });
    const items: HistoryItem[] = [];
    for (const record of records) {
      const fullFrame = this.makeChunk(request, snapshot, { events: [record.event], fragments: [] }, true, nextBefore);
      if (getUtf8ByteLengthV2(fullFrame) <= MAX_HISTORY_CHUNK_BYTES) { items.push({ kind: "event", event: record.event }); continue; }
      const encoded = new TextEncoder().encode(JSON.stringify(record.event));
      let index = 0;
      for (let offset = 0; offset < encoded.byteLength; offset += MAX_FRAGMENT_DECODE_BYTES) {
        const slice = encoded.slice(offset, offset + MAX_FRAGMENT_DECODE_BYTES);
        items.push({ kind: "fragment", eventId: record.event.event_id, index, dataBase64: Buffer.from(slice).toString("base64"), final: offset + slice.byteLength >= encoded.byteLength }); index += 1;
      }
    }
    const payloads: Payload[] = [];
    let current: Payload = { events: [], fragments: [] };
    for (const item of items) {
      const repeatedFragment = item.kind === "fragment" && current.fragments.some((fragment) => fragment.event_id === item.eventId);
      const candidate = appendItem(current, item);
      if (!repeatedFragment && this.nonFinalFrameBytes(request, snapshot, candidate) + tailOverhead <= MAX_HISTORY_CHUNK_BYTES) { current = candidate; continue; }
      if (current.events.length === 0 && current.fragments.length === 0) throw new HistoryTooLargeError("history item cannot fit in a 512 KiB chunk");
      payloads.push(current); current = appendItem({ events: [], fragments: [] }, item);
    }
    if (current.events.length > 0 || current.fragments.length > 0 || payloads.length === 0) payloads.push(current);
    return payloads.map((payload, chunkIndex) => {
      const final = chunkIndex === payloads.length - 1;
      const frame = this.makeChunk(request, snapshot, payload, final, nextBefore, chunkIndex);
      if (getUtf8ByteLengthV2(frame) > MAX_HISTORY_CHUNK_BYTES) throw new HistoryTooLargeError("history chunk exceeds 512 KiB");
      encodeServerFrameV2(frame); return frame;
    });
  }

  private makeChunk(request: HistorySyncRequest, snapshot: Snapshot, payload: Payload, final: boolean, nextBefore: number | undefined, chunkIndex = 0): ServerFrame {
    const tail = final ? nextBefore === undefined ? { final_chunk: true as const, eos: true as const } : { final_chunk: true as const, eos: false as const, next_before: nextBefore } : { final_chunk: false as const };
    return { protocol_version: 2, type: "session_history_chunk", target_channel_id: request.targetChannelId, in_reply_to: request.requestId, session_id: snapshot.sessionId, leaf_id: snapshot.leafId, chunk_index: chunkIndex, events: payload.events, fragments: payload.fragments, ...tail } as ServerFrame;
  }

  private nonFinalFrameBytes(request: HistorySyncRequest, snapshot: Snapshot, payload: Payload): number { return getUtf8ByteLengthV2(this.makeChunk(request, snapshot, payload, false, undefined)); }
  private finalFrameBytes(request: HistorySyncRequest, snapshot: Snapshot, payload: Payload, nextBefore: number | undefined): number { return getUtf8ByteLengthV2(this.makeChunk(request, snapshot, payload, true, nextBefore)); }
  private protocolError(request: HistorySyncRequest, code: "invalid_cursor" | "reset_required" | "too_large" | "internal_error", message: string): ServerFrame { return { protocol_version: 2, type: "protocol_error", target_channel_id: request.targetChannelId, in_reply_to: request.requestId, code, message }; }
  private reset(request: HistorySyncRequest, reason: "branch_changed" | "session_replaced"): ServerFrame { return { protocol_version: 2, type: "reset", target_channel_id: request.targetChannelId, session_id: this.sessionManager.getSessionId(), leaf_id: this.sessionManager.getLeafId() ?? null, reason }; }
}
class HistoryTooLargeError extends Error { constructor(message: string) { super(message); this.name = "HistoryTooLargeError"; } }
function sameIds(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((id, index) => id === right[index]); }
function appendItem(payload: Payload, item: HistoryItem): Payload { if (item.kind === "event") return { events: [...payload.events, item.event], fragments: [...payload.fragments] }; return { events: [...payload.events], fragments: [...payload.fragments, { event_id: item.eventId, index: item.index, data_base64: item.dataBase64, final: item.final }] }; }
