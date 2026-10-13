import { expect, test } from "vitest";
import { StreamDisplayBuffer } from "./stream-display-buffer";
import type { TimelineEvent, TimelinePartial } from "../pi-reach/protocol-v2/schema";
import type { TimelineViewItem } from "./timeline-runtime";
import { projectTimeline } from "./timeline-presentation";
import { ThinkingTextParser } from "./thinking-text-parser";

function partial(id: string, group: string, delta: string, kind: "assistant" | "thinking" | "tool" = "assistant"): TimelineViewItem {
  const value: TimelinePartial = kind === "tool"
    ? { protocol_version: 2, type: "timeline_partial", session_id: "s", leaf_id: "g", group_id: group, partial_id: id, kind, tool_call_id: `${id}-call`, tool: "bash", status: "delta", delta }
    : { protocol_version: 2, type: "timeline_partial", session_id: "s", leaf_id: "g", group_id: group, partial_id: id, kind, status: "delta", delta };
  return { kind: "partial", partial: value, createdAt: 1 };
}

function assistantEvent(id: string, group: string, text: string): TimelineViewItem {
  const event: TimelineEvent = { event_id: id, session_id: "s", leaf_id: "g", timestamp: 2, group_id: group, kind: "assistant", blocks: [{ type: "text", text }], status: "complete" };
  return { kind: "event", event };
}

function toolEvent(id: string, group: string, toolCallId: string): TimelineViewItem {
  const event: TimelineEvent = { event_id: id, session_id: "s", leaf_id: "g", timestamp: 2, group_id: group, kind: "tool", tool_call_id: toolCallId, tool: "bash", args: {}, truncated: false, status: "complete", result: "ok" };
  return { kind: "event", event };
}

function text(item: TimelineViewItem | undefined): string | undefined {
  return item?.kind === "partial" ? item.partial.delta : undefined;
}

test("shows only a small burst initially and drains within eight ticks", () => {
  const buffer = new StreamDisplayBuffer();
  const target = partial("p", "g", "abcdefghijklmnop");
  const first = buffer.ingest([target]);
  expect(text(first.items[0])).toBe("ab");
  let ticks = 0;
  while (buffer.hasPending() && ticks < 8) {
    buffer.advance();
    ticks += 1;
  }
  expect(ticks <= 8).toBe(true);
  expect(text(buffer.snapshot()[0])).toBe("abcdefghijklmnop");
});

test("does not split emoji graphemes", () => {
  const buffer = new StreamDisplayBuffer();
  const change = buffer.ingest([partial("p", "g", "👨‍👩‍👧‍👦👍🏽ok")]);
  expect(text(change.items[0])).toBe("👨‍👩‍👧‍👦👍🏽");
  while (buffer.hasPending()) buffer.advance();
  expect(text(buffer.snapshot()[0])).toBe("👨‍👩‍👧‍👦👍🏽ok");
});

test("resegments the previous grapheme when an emoji modifier arrives", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.ingest([partial("p", "g", "👍")]);
  const appended = buffer.ingest([partial("p", "g", "👍🏽ok")]);
  expect(appended.shouldRender).toBe(false);
  const advanced = buffer.advance();
  expect(text(advanced.items[0])).toBe("👍🏽o");
  while (buffer.hasPending()) buffer.advance();
  expect(text(buffer.snapshot()[0])).toBe("👍🏽ok");
});

test("keeps independent partial lanes separate", () => {
  const buffer = new StreamDisplayBuffer();
  const change = buffer.ingest([partial("a", "ga", "alpha"), partial("b", "gb", "bravo")]);
  expect(change.items.filter((item) => item.kind === "partial").map(text)).toEqual(["al", "br"]);
});

test("shows the matching formal event immediately without replaying its buffered tail", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.ingest([partial("e:assistant:0", "g", "long answer")]);
  const withFormal = buffer.ingest([assistantEvent("e", "g", "long answer"), partial("e:assistant:0", "g", "long answer")]);
  expect(withFormal.items).toEqual([assistantEvent("e", "g", "long answer")]);
  expect(buffer.hasPending()).toBe(false);
});

test("removes a partial immediately when its group has no formal event", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.ingest([partial("p", "g", "answer")]);
  const cleared = buffer.ingest([]);
  expect(cleared.items.length).toBe(0);
  expect(buffer.hasPending()).toBe(false);
});

test("tool partials are shown in full immediately", () => {
  const buffer = new StreamDisplayBuffer();
  const change = buffer.ingest([partial("tool", "g", "tool output", "tool")]);
  expect(text(change.items[0])).toBe("tool output");
  expect(change.hasPending).toBe(false);
});

test("keeps another tool stream visible when a tool in the same group completes", () => {
  const buffer = new StreamDisplayBuffer();
  const first = partial("tool-a", "g", "first output", "tool");
  const second = partial("tool-b", "g", "second output", "tool");
  buffer.ingest([first, second]);

  const changed = buffer.ingest([toolEvent("event-a", "g", "tool-a-call"), second]);

  expect(changed.items).toContainEqual(expect.objectContaining({ kind: "event", event: expect.objectContaining({ tool_call_id: "tool-a-call" }) }));
  expect(changed.items).toContainEqual(expect.objectContaining({ kind: "partial", partial: expect.objectContaining({ tool_call_id: "tool-b-call" }) }));
});

test("same partial target does not require another render", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.ingest([partial("p", "g", "abcdef")]);
  const repeated = buffer.ingest([partial("p", "g", "abcdef")]);
  expect(repeated.shouldRender).toBe(false);
});

test("keeps the full text after many small deltas", () => {
  const buffer = new StreamDisplayBuffer();
  const target = "x".repeat(1000);
  for (let length = 1; length <= target.length; length += 1) {
    buffer.ingest([partial("p", "g", target.slice(0, length))]);
  }
  while (buffer.hasPending()) buffer.advance();
  expect(text(buffer.snapshot()[0])).toBe(target);
});

test("caps a new large burst after the lane has drained", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.ingest([partial("p", "g", "ok")]);
  const target = `ok${"x".repeat(1000)}`;
  const appended = buffer.ingest([partial("p", "g", target)]);
  expect(appended.shouldRender).toBe(false);
  const firstTick = buffer.advance();
  const firstText = text(firstTick.items[0]);
  expect(firstText).toBeTruthy();
  expect(firstText!.length).toBeLessThan(target.length);
  expect(firstText!.length).toBeLessThanOrEqual(66);
  while (buffer.hasPending()) buffer.advance();
  expect(text(buffer.snapshot()[0])).toBe(target);
});

function epoch(item: TimelineViewItem | undefined): object | undefined {
  return item?.kind === "partial" ? item.thinkingTextEpoch : undefined;
}

test("thinking epochs stay stable through trusted appends and ticks, but reset on replacements and reset", () => {
  const buffer = new StreamDisplayBuffer();
  const first = buffer.ingest([partial("p:thinking:0", "g", "👍", "thinking")]);
  const token = epoch(first.items[0]);
  expect(token).toBeDefined();
  buffer.ingest([partial("p:thinking:0", "g", "👍🏽\n**Title**", "thinking")]);
  while (buffer.hasPending()) {
    const changed = buffer.advance();
    expect(epoch(changed.items[0])).toBe(token);
    expect(text(changed.items[0])?.startsWith("👍")).toBe(true);
  }
  expect(epoch(buffer.ingest([partial("p:thinking:0", "g", "Replacement", "thinking")]).items[0])).not.toBe(token);
  const replaced = epoch(buffer.snapshot()[0]);
  expect(epoch(buffer.reset([partial("p:thinking:0", "g", "Replacement", "thinking")]).items[0])).not.toBe(replaced);
  const reset = epoch(buffer.snapshot()[0]);
  buffer.ingest([]);
  expect(epoch(buffer.ingest([partial("p:thinking:0", "g", "Replacement", "thinking")]).items[0])).not.toBe(reset);
});

test("exposes epochs only on the view of blockless thinking, never on the wire partial", () => {
  const buffer = new StreamDisplayBuffer();
  const thought = partial("p:thinking:0", "g", "Text", "thinking");
  if (thought.kind !== "partial" || thought.partial.kind !== "thinking") throw new Error("invalid fixture");
  const blocked = { ...thought, partial: { ...thought.partial, blocks: [{ type: "thinking" as const, text: "Text" }] } };
  const items = buffer.reset([thought, partial("a", "g", "Text"), partial("t", "g", "Text", "tool")]).items;
  expect(items.map(epoch)).toEqual([expect.any(Object), undefined, undefined]);
  expect(items[0]?.kind === "partial" && "thinkingTextEpoch" in items[0].partial).toBe(false);
  const token = epoch(items[0]);
  expect(epoch(buffer.ingest([blocked]).items[0])).toBeUndefined();
  expect(epoch(buffer.ingest([thought]).items[0])).not.toBe(token);
});

test("buffer to presentation to parser scans exactly the displayed suffix and rebuilds at formal takeover", () => {
  const buffer = new StreamDisplayBuffer();
  const parser = new ThinkingTextParser();
  const target = `\n \t\n${"x".repeat(2048)}\n**Last title**`;
  const read = (items: TimelineViewItem[]) => {
    const entry = projectTimeline(items).entries[0];
    if (entry?.kind !== "thinking") throw new Error("missing thinking entry");
    return parser.read(entry.text, entry.thinkingTextEpoch);
  };
  for (let length = 0; length < target.length; length += 31) {
    read(buffer.ingest([partial("p:thinking:0", "g", target.slice(0, length), "thinking")]).items);
    read(buffer.advance().items);
  }
  read(buffer.ingest([partial("p:thinking:0", "g", target, "thinking")]).items);
  while (buffer.hasPending()) read(buffer.advance().items);
  expect(parser.scannedCharacters).toBe(target.length);
  expect(read(buffer.snapshot())).toMatchObject({ latestTitle: "Last title", summary: "x".repeat(2048) });
  const formal = assistantEvent("p", "g", target);
  if (formal.kind !== "event" || formal.event.kind !== "assistant") throw new Error("invalid fixture");
  formal.event.blocks = [{ type: "thinking", text: target }];
  const settled = buffer.ingest([formal]).items;
  expect(read(settled).firstTitle).toBe("Last title");
  expect(parser.scannedCharacters).toBe(target.length * 2);
  read(settled);
  expect(parser.scannedCharacters).toBe(target.length * 2);
});

test("reset renders the latest authoritative formal event in full", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.ingest([partial("p", "g", "a long response")]);
  const change = buffer.reset([assistantEvent("e", "g", "a long response")]);
  expect(change.shouldRender).toBe(true);
  expect(change.items.some((item) => item.kind === "partial")).toBe(false);
  expect(change.items.some((item) => item.kind === "event")).toBe(true);
  expect(buffer.hasPending()).toBe(false);
});
