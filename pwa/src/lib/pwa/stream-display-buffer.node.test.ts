import { expect, test, vi } from "vitest";
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

function blocksPartial(blocks: NonNullable<Extract<TimelinePartial, { kind: "assistant" }>["blocks"]>, kind: "assistant" | "thinking" = "assistant"): TimelineViewItem {
  const base = { protocol_version: 2 as const, type: "timeline_partial" as const, session_id: "s", leaf_id: "g", group_id: "g", partial_id: "p", status: "delta" as const };
  const value: TimelinePartial = kind === "assistant" ? { ...base, kind, blocks } : { ...base, kind, blocks: blocks.map(block => {
    if (block.type !== "thinking") throw new Error("invalid thinking fixture");
    return block;
  }) };
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

test("exposes epochs on every thinking view, never on the wire partial or non-thinking views", () => {
  const buffer = new StreamDisplayBuffer();
  const thought = partial("p:thinking:0", "g", "Text", "thinking");
  if (thought.kind !== "partial" || thought.partial.kind !== "thinking") throw new Error("invalid fixture");
  const blocked = { ...thought, partial: { ...thought.partial, blocks: [{ type: "thinking" as const, text: "Text" }] } };
  const items = buffer.reset([thought, partial("a", "g", "Text"), partial("t", "g", "Text", "tool")]).items;
  expect(items.map(epoch)).toEqual([expect.any(Object), undefined, undefined]);
  expect(items[0]?.kind === "partial" && "thinkingTextEpoch" in items[0].partial).toBe(false);
  const token = epoch(items[0]);
  const blockedItems = buffer.ingest([blocked]).items;
  expect(epoch(blockedItems[0])).toBeDefined();
  expect(epoch(blockedItems[0])).not.toBe(token);
  expect(blockedItems[0]?.kind === "partial" && "thinkingTextEpoch" in blockedItems[0].partial).toBe(false);
  expect(epoch(buffer.ingest([thought]).items[0])).not.toBe(epoch(blockedItems[0]));
  const mixed = blocksPartial([{ type: "text", text: "Answer" }, { type: "thinking", text: "Text" }]);
  const projected = buffer.reset([mixed]).items;
  expect(epoch(projected[0])).toBeDefined();
  expect(projectTimeline(projected).entries.filter(entry => entry.kind === "thinking").map(entry => entry.thinkingTextEpoch)).toEqual([epoch(projected[0])]);
  const noThinking = blocksPartial([{ type: "text", text: "Answer" }]);
  const toolBlocks = partial("t", "g", "Text", "tool");
  if (toolBlocks.kind !== "partial") throw new Error("invalid fixture");
  toolBlocks.partial.blocks = [{ type: "thinking", text: "Tool thought" }];
  expect(buffer.reset([noThinking, toolBlocks]).items.map(epoch)).toEqual([undefined, undefined]);
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

test.each(["assistant", "thinking"] as const)("cumulative %s thinking blocks scan only appended characters through buffer and projection", kind => {
  const buffer = new StreamDisplayBuffer();
  const parser = new ThinkingTextParser();
  const target = `${"x".repeat(2048)}\n**First title**\nBody\n**Latest title**`;
  const read = (items: TimelineViewItem[]) => {
    const entry = projectTimeline(items).entries[0];
    if (entry?.kind !== "thinking") throw new Error("missing thinking entry");
    return parser.read(entry.text, entry.thinkingTextEpoch, entry.streaming);
  };
  for (let length = 0; length < target.length; length += 31) {
    read(buffer.ingest([blocksPartial([{ type: "thinking", text: target.slice(0, length) }], kind)]).items);
    read(buffer.advance().items);
  }
  const full = buffer.ingest([blocksPartial([{ type: "thinking", text: target }], kind)]);
  expect(full.hasPending).toBe(false);
  expect(read(full.items).latestTitle).toBe("Latest title");
  expect(parser.scannedCharacters).toBe(target.length);
  read(buffer.snapshot());
  expect(parser.scannedCharacters).toBe(target.length);
  const formal = assistantEvent("p", "g", target);
  if (formal.kind !== "event" || formal.event.kind !== "assistant") throw new Error("invalid fixture");
  formal.event.blocks = [{ type: "thinking", text: target }];
  expect(read(buffer.ingest([formal]).items).firstTitle).toBe("First title");
  expect(parser.scannedCharacters).toBe(target.length * 2);
});

test.each(["assistant", "thinking"] as const)("%s thinking blocks handle the complete legal append and replacement matrix", kind => {
  const before = [{ type: "thinking" as const, text: "aa" }, { type: "thinking" as const, text: "bb" }];
  const cases = [
    { name: "unchanged", texts: ["aa", "bb"], trusted: true },
    { name: "per-block append", texts: ["aaa", "bbb"], trusted: true },
    { name: "appended block", texts: ["aa", "bb", "cc"], trusted: true },
    { name: "rollback", texts: ["a", "bb"], trusted: false },
    { name: "same-length replacement", texts: ["zz", "bb"], trusted: false },
    { name: "reordered content", texts: ["bb", "aa"], trusted: false },
    { name: "removed block", texts: ["aa"], trusted: false },
    { name: "same join with changed boundaries", texts: ["aa\nbb"], trusted: false },
  ];
  for (const scenario of cases) {
    const buffer = new StreamDisplayBuffer();
    const token = epoch(buffer.ingest([blocksPartial(before, kind)]).items[0]);
    const changed = buffer.ingest([blocksPartial(scenario.texts.map(text => ({ type: "thinking", text })), kind)]);
    expect(epoch(changed.items[0]) === token, scenario.name).toBe(scenario.trusted);
    expect(changed.shouldRender, scenario.name).toBe(scenario.name !== "unchanged");
    expect(projectTimeline(changed.items).entries.filter(entry => entry.kind === "thinking").map(entry => entry.text), scenario.name).toEqual(scenario.texts);
  }
});

test.each(["assistant", "thinking"] as const)("%s empty blocks can append an empty thinking entry despite unchanged joined text", kind => {
  const buffer = new StreamDisplayBuffer();
  expect(projectTimeline(buffer.ingest([blocksPartial([], kind)]).items).entries).toEqual([]);
  const appended = buffer.ingest([blocksPartial([{ type: "thinking", text: "" }], kind)]);
  expect(appended.shouldRender).toBe(true);
  expect(epoch(appended.items[0])).toBeDefined();
  expect(projectTimeline(appended.items).entries).toEqual([expect.objectContaining({ kind: "thinking", text: "", thinkingTextEpoch: epoch(appended.items[0]) })]);
  expect(buffer.ingest([blocksPartial([{ type: "thinking", text: "" }], kind)]).shouldRender).toBe(false);
});

test("blockless kind changes refresh the epoch without changing existing append pacing", () => {
  const buffer = new StreamDisplayBuffer();
  buffer.reset([partial("p", "g", "abcd")]);
  const changed = buffer.ingest([partial("p", "g", "abcdef", "thinking")]);
  expect(changed.shouldRender).toBe(true);
  expect(epoch(changed.items[0])).toBeDefined();
  expect(text(changed.items[0])).toBe("abcd");
  expect(changed.hasPending).toBe(true);
  while (buffer.hasPending()) buffer.advance();
  expect(text(buffer.snapshot()[0])).toBe("abcdef");
});

test("mixed text and multiple thinking blocks keep each parser incremental including appended blocks", () => {
  const buffer = new StreamDisplayBuffer();
  const parsers = new Map<string, ThinkingTextParser>();
  const read = (items: TimelineViewItem[]) => {
    for (const entry of projectTimeline(items).entries) {
      if (entry.kind !== "thinking") continue;
      const parser = parsers.get(entry.key) ?? new ThinkingTextParser();
      parsers.set(entry.key, parser);
      parser.read(entry.text, entry.thinkingTextEpoch, entry.streaming);
    }
  };
  const initial = [{ type: "text" as const, text: "Answer" }, { type: "thinking" as const, text: "**First**\n" }, { type: "thinking" as const, text: "Reason" }];
  const first = buffer.ingest([blocksPartial(initial)]);
  const token = epoch(first.items[0]);
  read(first.items);
  for (let length = 1; length <= 128; length++) {
    const next = buffer.ingest([blocksPartial(initial.map(block => ({ ...block, text: `${block.text}${"x".repeat(length)}` })))]);
    expect(epoch(next.items[0])).toBe(token);
    read(next.items);
    read(buffer.advance().items);
  }
  const appended = [...initial.map(block => ({ ...block, text: `${block.text}${"x".repeat(128)}` })), { type: "thinking" as const, text: "**New block**" }];
  const next = buffer.ingest([blocksPartial(appended)]);
  expect(epoch(next.items[0])).toBe(token);
  read(next.items);
  expect([...parsers.values()].reduce((sum, parser) => sum + parser.scannedCharacters, 0)).toBe(appended.filter(block => block.type === "thinking").reduce((sum, block) => sum + block.text.length, 0));
});

test.each([
  { name: "unchanged blocks", next: [{ type: "thinking", text: "aa" }, { type: "text", text: "bb" }], trusted: true },
  { name: "per-block append even when joined text is not a prefix", next: [{ type: "thinking", text: "aaa" }, { type: "text", text: "bbb" }], trusted: true },
  { name: "new block", next: [{ type: "thinking", text: "aa" }, { type: "text", text: "bb" }, { type: "thinking", text: "cc" }], trusted: true },
  { name: "replacement", next: [{ type: "thinking", text: "changed" }, { type: "text", text: "bb" }], trusted: false },
  { name: "rollback", next: [{ type: "thinking", text: "a" }, { type: "text", text: "bb" }], trusted: false },
  { name: "same-length replacement", next: [{ type: "thinking", text: "zz" }, { type: "text", text: "bb" }], trusted: false },
  { name: "non-thinking replacement", next: [{ type: "thinking", text: "aa" }, { type: "text", text: "zz" }], trusted: false },
  { name: "removed block", next: [{ type: "thinking", text: "aa" }], trusted: false },
  { name: "type swap with the same joined text", next: [{ type: "text", text: "aa" }, { type: "thinking", text: "bb" }], trusted: false },
  { name: "reordered blocks", next: [{ type: "text", text: "bb" }, { type: "thinking", text: "aa" }], trusted: false },
  { name: "same joined text with different boundaries", next: [{ type: "thinking", text: "aa\nbb" }], trusted: false },
] satisfies { name: string; next: NonNullable<Extract<TimelinePartial, { kind: "assistant" }>["blocks"]>; trusted: boolean }[])("blocks epoch handles $name", ({ name, next, trusted }) => {
  const buffer = new StreamDisplayBuffer();
  const first = buffer.ingest([blocksPartial([{ type: "thinking", text: "aa" }, { type: "text", text: "bb" }])]);
  const token = epoch(first.items[0]);
  expect(token).toBeDefined();
  const changed = buffer.ingest([blocksPartial(next)]);
  expect(epoch(changed.items[0]) === token).toBe(trusted);
  expect(changed.shouldRender).toBe(name !== "unchanged blocks");
  expect(changed.hasPending).toBe(false);
  expect(projectTimeline(changed.items).entries.map(entry => "text" in entry ? entry.text : undefined)).toEqual(next.map(block => block.text));
});

test("blocks replacements rebuild parser results even when concatenated text stays unchanged", () => {
  const buffer = new StreamDisplayBuffer();
  const parser = new ThinkingTextParser();
  const read = (items: TimelineViewItem[]) => {
    const entry = projectTimeline(items).entries[0];
    if (entry?.kind !== "thinking") throw new Error("missing thinking entry");
    return parser.read(entry.text, entry.thinkingTextEpoch, entry.streaming);
  };
  read(buffer.ingest([blocksPartial([{ type: "thinking", text: "**Old**" }, { type: "text", text: "**New**" }])]).items);
  const changed = buffer.ingest([blocksPartial([{ type: "thinking", text: "**Old**\n**New**" }])]);
  expect(changed.shouldRender).toBe(true);
  expect(read(changed.items).latestTitle).toBe("New");
  expect(parser.scannedCharacters).toBe("**Old**".length + "**Old**\n**New**".length);
  const replaced = buffer.ingest([blocksPartial([{ type: "thinking", text: "**Now**\n**End**" }])]);
  expect(read(replaced.items)).toMatchObject({ firstTitle: "Now", latestTitle: "End" });
  expect(parser.scannedCharacters).toBe("**Old**".length + "**Old**\n**New**".length + "**Now**\n**End**".length);
});

test("blocks epochs refresh on kind and mode changes, reset and deletion restart", () => {
  const buffer = new StreamDisplayBuffer();
  const blocks = [{ type: "thinking" as const, text: "**Title**" }];
  const first = epoch(buffer.ingest([blocksPartial(blocks)]).items[0]);
  const kindChanged = epoch(buffer.ingest([blocksPartial(blocks, "thinking")]).items[0]);
  expect(kindChanged).toBeDefined();
  expect(kindChanged).not.toBe(first);
  const plain = partial("p", "g", "**Title**", "thinking");
  const modeChanged = epoch(buffer.ingest([plain]).items[0]);
  expect(modeChanged).not.toBe(kindChanged);
  const blocked = epoch(buffer.ingest([blocksPartial(blocks, "thinking")]).items[0]);
  expect(blocked).not.toBe(modeChanged);
  const reset = epoch(buffer.reset([blocksPartial(blocks, "thinking")]).items[0]);
  expect(reset).not.toBe(blocked);
  buffer.ingest([]);
  expect(epoch(buffer.ingest([blocksPartial(blocks, "thinking")]).items[0])).not.toBe(reset);
});

function segmentSpy() {
  return vi.spyOn(Intl.Segmenter.prototype, "segment");
}

test("immediate streams never segment text for init, append, replacement, reset or flush", () => {
  const segment = segmentSpy();
  const buffer = new StreamDisplayBuffer();
  expect(text(buffer.ingest([partial("tool", "g", "tool output", "tool")]).items[0])).toBe("tool output");
  expect(text(buffer.ingest([partial("tool", "g", "tool output extended", "tool")]).items[0])).toBe("tool output extended");
  expect(text(buffer.ingest([partial("tool", "g", "tool replaced", "tool")]).items[0])).toBe("tool replaced");
  const blocks = buffer.ingest([blocksPartial([{ type: "text", text: "Answer" }, { type: "thinking", text: "**Thought**" }])]);
  expect(blocks.items[0]?.kind === "partial" && blocks.items[0].partial.blocks?.map(block => block.text)).toEqual(["Answer", "**Thought**"]);
  buffer.ingest([blocksPartial([{ type: "text", text: "Answer more" }, { type: "thinking", text: "**Thought** continues" }])]);
  buffer.ingest([blocksPartial([{ type: "text", text: "Replaced" }])]);
  buffer.advance();
  const reset = buffer.reset([partial("p", "g", "answer after reset"), partial("tool", "g", "tool after reset", "tool")]);
  expect(reset.items.map(text)).toEqual(["answer after reset", "tool after reset"]);
  expect(text(buffer.flush().items[0])).toBe("answer after reset");
  buffer.advance();
  expect(segment).not.toHaveBeenCalled();
  segment.mockRestore();
});

test("paced lanes segment on demand, keep the displayed prefix and never resegment on ticks", () => {
  const segment = segmentSpy();
  const buffer = new StreamDisplayBuffer();
  const target = "👍🏽abc and a long tail";
  expect(text(buffer.ingest([partial("p", "g", "👍🏽abc")]).items[0])).toBe("👍🏽a");
  const appended = buffer.ingest([partial("p", "g", target)]);
  expect(text(appended.items[0])).toBe("👍🏽a");
  const segmentsAfterAppend = segment.mock.calls.length;
  expect(segmentsAfterAppend).toBeGreaterThan(0);
  while (buffer.hasPending()) {
    const tick = buffer.advance();
    expect(target.startsWith(text(tick.items[0])!)).toBe(true);
    expect(text(tick.items[0])!.startsWith("👍🏽a")).toBe(true);
  }
  expect(text(buffer.snapshot()[0])).toBe(target);
  expect(segment.mock.calls.length).toBe(segmentsAfterAppend);
  // 即时展示切换到按需展示：用已显示前缀重建游标，不重播也不丢字。
  buffer.reset([blocksPartial([{ type: "text", text: "answer" }])]);
  const enteredPaced = buffer.ingest([partial("p", "g", "answer plus tail")]);
  expect(text(enteredPaced.items[0])).toBe("answer");
  while (buffer.hasPending()) buffer.advance();
  expect(text(buffer.snapshot()[0])).toBe("answer plus tail");
  const segmentsAfterDrain = segment.mock.calls.length;
  const immediate = buffer.ingest([blocksPartial([{ type: "text", text: "answer plus tail" }])]);
  const blocks = immediate.items[0];
  if (blocks?.kind !== "partial" || blocks.partial.blocks === undefined) throw new Error("invalid fixture");
  expect(blocks.partial.blocks.map(block => block.text)).toEqual(["answer plus tail"]);
  expect(buffer.hasPending()).toBe(false);
  buffer.advance();
  expect(segment.mock.calls.length).toBe(segmentsAfterDrain);
  segment.mockRestore();
});

test("mixed lanes keep immediate text whole while only the paced lane builds a cursor", () => {
  const segment = segmentSpy();
  const buffer = new StreamDisplayBuffer();
  const change = buffer.ingest([
    partial("a", "g", "plain lane"),
    partial("tool", "g", "tool output", "tool"),
    blocksPartial([{ type: "text", text: "Blocks answer" }]),
  ]);
  expect(text(change.items[0])).toBe("pl");
  expect(text(change.items[1])).toBe("tool output");
  const blocks = change.items[2];
  if (blocks?.kind !== "partial" || blocks.partial.blocks === undefined) throw new Error("invalid fixture");
  expect(blocks.partial.blocks.map(block => block.text)).toEqual(["Blocks answer"]);
  expect(segment.mock.calls.length).toBeLessThanOrEqual(1);
  while (buffer.hasPending()) buffer.advance();
  expect(text(buffer.snapshot()[0])).toBe("plain lane");
  expect(segment.mock.calls.length).toBeLessThanOrEqual(1);
  segment.mockRestore();
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
