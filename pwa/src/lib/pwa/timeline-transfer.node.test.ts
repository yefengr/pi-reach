import { expect, test } from "vitest";
import { HistoryWindowAssembler, TimelineEventFragmentAssembler } from "./timeline-transfer";
import type { HistoryChunkFrame, TimelineEventFragmentFrame } from "./timeline-transfer";
import type { TimelineEvent } from "../pi-reach/protocol-v2/schema";

const scope = { session_id: "S1", leaf_id: "G1" } as const;
const version = { protocol_version: 2 as const };
const direct = { target_channel_id: "C1" };

function userEvent(eventId: string, eventSeq?: number): TimelineEvent {
  return {
    event_id: eventId,
    ...(eventSeq === undefined ? {} : { event_seq: eventSeq }),
    session_id: scope.session_id,
    leaf_id: scope.leaf_id,
    timestamp: 100,
    group_id: "GR1",
    kind: "user",
    message_id: eventId,
    blocks: [{ type: "text", text: eventId }],
    origin: "pwa",
    sender_ref: "sender-1",
    delivery: "normal",
    status: "committed",
  };
}

function assistantEvent(eventId = "A1", eventSeq?: number): TimelineEvent {
  return {
    event_id: eventId,
    ...(eventSeq === undefined ? {} : { event_seq: eventSeq }),
    session_id: scope.session_id,
    leaf_id: scope.leaf_id,
    timestamp: 101,
    group_id: "GR1",
    kind: "assistant",
    blocks: [{ type: "text", text: "done" }],
    status: "complete",
  };
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeJson(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function fragmentFrame(
  eventId: string,
  index: number,
  data: string,
  final: boolean,
  overrides: Partial<TimelineEventFragmentFrame> = {},
): TimelineEventFragmentFrame {
  return {
    ...version,
    type: "timeline_event_fragment",
    ...scope,
    event_id: eventId,
    index,
    data_base64: data,
    final,
    ...overrides,
  };
}

function historyChunk(
  requestId: string,
  index: number,
  overrides: Partial<HistoryChunkFrame> = {},
): HistoryChunkFrame {
  const base = {
    ...version,
    type: "session_history_chunk" as const,
    ...direct,
    in_reply_to: requestId,
    ...scope,
    leaf_id: "HEAD",
    chunk_index: index,
    events: [],
    fragments: [],
  };
  const scopedBase = {
    ...base,
    session_id: overrides.session_id ?? base.session_id,
    leaf_id: overrides.leaf_id ?? scope.leaf_id,
  };
  if (overrides.final_chunk === true && overrides.eos === true) return { ...scopedBase, events: overrides.events ?? [], fragments: overrides.fragments ?? [], final_chunk: true, eos: true };
  if (overrides.final_chunk === true && overrides.eos === false && overrides.next_before) return { ...scopedBase, events: overrides.events ?? [], fragments: overrides.fragments ?? [], final_chunk: true, eos: false, next_before: overrides.next_before };
  return { ...scopedBase, events: overrides.events ?? [], fragments: overrides.fragments ?? [], final_chunk: false };
}

test("assembles out-of-order history chunks in chunk order", () => {
  const assembler = new HistoryWindowAssembler("REQ1");
  const first = historyChunk("REQ1", 0, { events: [userEvent("U1", 2)] });
  const tail = historyChunk("REQ1", 1, { events: [assistantEvent("A1", 1)], final_chunk: true, eos: false, next_before: 1 });

  expect(assembler.accept(tail)).toEqual({ status: "pending" });
  expect(assembler.accept(first)).toEqual({
    status: "complete",
    events: [assistantEvent("A1", 1), userEvent("U1", 2)],
    eos: false,
    next_before: 1,
  });
});

test("discards missing, duplicate, and wrong-generation history windows", () => {
  const missing = new HistoryWindowAssembler("REQ1");
  expect(missing.accept(historyChunk("REQ1", 1, { final_chunk: true, eos: true }))).toEqual({ status: "pending" });
  expect(missing.finalize()).toEqual({ status: "discarded", reason: "history_chunk_gap" });

  const duplicate = new HistoryWindowAssembler("REQ1");
  expect(duplicate.accept(historyChunk("REQ1", 0))).toEqual({ status: "pending" });
  expect(duplicate.accept(historyChunk("REQ1", 0))).toEqual({ status: "discarded", reason: "duplicate_chunk" });

  const generation = new HistoryWindowAssembler("REQ1");
  expect(generation.accept(historyChunk("REQ1", 0, { events: [userEvent("G1", 1)] }))).toEqual({ status: "pending" });
  expect(generation.accept(historyChunk("REQ1", 1, {
    final_chunk: true,
    eos: true,
    leaf_id: "G2",
  }))).toEqual({ status: "discarded", reason: "history_scope_mismatch" });
});

test("accepts mixed event leaves inside a history frame while keeping the outer leaf strict", () => {
  const mixed = { ...assistantEvent("A-mixed", 1), leaf_id: "earlier-leaf" };
  const assembler = new HistoryWindowAssembler("REQ-mixed", scope);
  expect(assembler.accept(historyChunk("REQ-mixed", 0, { events: [mixed], final_chunk: true, eos: true }))).toEqual({
    status: "complete",
    events: [mixed],
    eos: true,
  });

  const wrongOuterLeaf = new HistoryWindowAssembler("REQ-wrong", scope);
  expect(wrongOuterLeaf.accept(historyChunk("REQ-wrong", 0, { leaf_id: "other-leaf", events: [mixed], final_chunk: true, eos: true }))).toEqual({
    status: "discarded",
    reason: "history_scope_mismatch",
  });
});

test("reassembles a realtime fragment event across chunks and rejects invalid JSON", () => {
  const event = assistantEvent();
  const encoded = new TextEncoder().encode(JSON.stringify(event));
  const split = Math.floor(encoded.length / 2);
  const assembler = new TimelineEventFragmentAssembler(scope);

  expect(assembler.accept(fragmentFrame("A1", 0, encodeBytes(encoded.slice(0, split)), false))).toEqual({ status: "pending" });
  expect(assembler.accept(fragmentFrame("A1", 1, encodeBytes(encoded.slice(split)), true))).toEqual({ status: "complete", event });

  const invalid = new TimelineEventFragmentAssembler(scope);
  expect(invalid.accept(fragmentFrame("BAD", 0, encodeJson("invalid"), true))).toEqual({ status: "discarded", reason: "fragment_event_invalid" });
});

test("discards duplicate or missing fragment indexes and scope violations", () => {
  const event = assistantEvent("A2");
  const encoded = encodeJson(event);
  const assembler = new TimelineEventFragmentAssembler(scope);
  expect(assembler.accept(fragmentFrame("A2", 0, encoded.slice(0, 4), false))).toEqual({ status: "pending" });
  expect(assembler.accept(fragmentFrame("A2", 0, encodeJson("different"), false))).toEqual({ status: "discarded", reason: "invalid_fragment_sequence" });

  const missing = new TimelineEventFragmentAssembler(scope);
  expect(missing.accept(fragmentFrame("A2", 1, encoded.slice(4), true))).toEqual({ status: "pending" });
  const wrongScope = new TimelineEventFragmentAssembler(scope);
  expect(wrongScope.accept(fragmentFrame("A2", 0, encoded, true, { leaf_id: "G2" }))).toEqual({ status: "discarded", reason: "fragment_scope_mismatch" });
});

test("enforces the 32 MiB decoded window budget", () => {
  const assembler = new HistoryWindowAssembler("REQ1");
  const chunks = Array.from({ length: 73 }, (_, index) => historyChunk("REQ1", index, {
    events: [userEvent(`E${index}`, index + 1)],
  }));
  for (const chunk of chunks) {
    const event = chunk.events[0] as Extract<TimelineEvent, { kind: "user" }>;
    event.blocks = [{ type: "text", text: "x".repeat(450 * 1024) }];
  }
  chunks[72] = historyChunk("REQ1", 72, {
    events: chunks[72].events,
    final_chunk: true,
    eos: true,
  });
  for (const chunk of chunks.slice(0, -1)) expect(assembler.accept(chunk)).toEqual({ status: "pending" });
  expect(assembler.accept(chunks[72])).toEqual({ status: "discarded", reason: "window_too_large" });
});
