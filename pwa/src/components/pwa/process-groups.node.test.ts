import { describe, expect, test } from "vitest";
import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { projectTimeline, type PresentationEntry, type PresentationSnapshot } from "@/lib/pwa/timeline-presentation";
import {
  processExpansion, processGroups, processNoticeBreakKeys, withProcessExpansion,
  type ProcessEntry, type ProcessGroup,
} from "./process-groups";

const scope = { session_id: "s", leaf_id: "l" };

type ToolEvent = Extract<TimelineEvent, { kind: "tool" }>;
type ToolPartial = Extract<TimelinePartial, { kind: "tool" }>;

const toolEvent = (id: string, group = "g1", status: "complete" | "error" = "complete"): ToolEvent => ({
  ...scope, event_id: `event-${id}`, group_id: group, timestamp: 1, kind: "tool", tool_call_id: id,
  tool: "bash", args: { command: id }, truncated: false,
  ...(status === "error" ? { status, error: "failed" } : { status, result: "ok" }),
});
const tool = (id: string, group = "g1", status: "complete" | "error" = "complete"): TimelineViewItem => ({ kind: "event", event: toolEvent(id, group, status) });
const runningTool = (id: string, group = "g1"): TimelineViewItem => ({
  kind: "partial", createdAt: 0,
  partial: { protocol_version: 2, type: "timeline_partial", ...scope, group_id: group, partial_id: `tool:${id}`, kind: "tool",
    tool_call_id: id, tool: "bash", args: { command: id }, status: "running" } satisfies ToolPartial,
});
const thinkingEvent = (id: string, group = "g1", text = `Think ${id}`): Extract<TimelineEvent, { kind: "assistant" }> => ({
  ...scope, event_id: id, group_id: group, timestamp: 1, kind: "assistant", status: "complete",
  blocks: [{ type: "thinking", text }],
});
const thinking = (id: string, group = "g1", text?: string): TimelineViewItem => ({ kind: "event", event: thinkingEvent(id, group, text) });
const textEvent = (id: string, group = "g1"): Extract<TimelineEvent, { kind: "assistant" }> => ({
  ...scope, event_id: id, group_id: group, timestamp: 1, kind: "assistant", status: "complete", blocks: [{ type: "text", text: id }],
});
const text = (id: string, group = "g1"): TimelineViewItem => ({ kind: "event", event: textEvent(id, group) });
const user: TimelineViewItem = {
  kind: "event", event: { ...scope, event_id: "user", message_id: "user", group_id: "g1", timestamp: 2, kind: "user",
    blocks: [{ type: "text", text: "Hi" }], origin: "pwa", sender_ref: "me", delivery: "normal", status: "committed" },
};
const file: TimelineViewItem = {
  kind: "event", event: { ...scope, event_id: "file", group_id: "g1", timestamp: 2, kind: "custom", truncated: false,
    payload: { custom_type: "pi-reach:published-file-v1",
      data: { file_name: "report.txt", mime_type: "text/plain", byte_length: 3, tool_call_id: "call" } } },
};
const summary: TimelineViewItem = {
  kind: "event", event: { ...scope, event_id: "summary", group_id: "g1", timestamp: 2, kind: "compaction",
    payload: { summary: "Compacted" }, truncated: false },
};
const runEnd: TimelineViewItem = { kind: "event", event: { ...scope, event_id: "end", group_id: "g1", timestamp: 2, kind: "run_end", status: "complete" } };

const withSeq = (view: TimelineViewItem, seq: number): TimelineViewItem => view.kind === "event"
  ? { kind: "event", event: { ...view.event, event_seq: seq } } : view;
const entriesOf = (items: TimelineViewItem[], previous?: PresentationSnapshot): PresentationEntry[] => projectTimeline(items, previous).entries;
const groupsOf = (entries: readonly PresentationEntry[], breakKeys: ReadonlySet<string> = new Set(), previous: readonly ProcessGroup[] = []) => processGroups(entries, breakKeys, previous);
const members = (group: ProcessGroup): string[] => group.entries.map(entry => entry.key);
const processKeys = (entries: readonly PresentationEntry[]): string[] => entries
  .filter((entry): entry is ProcessEntry => entry.kind === "thinking" || entry.kind === "tool")
  .map(entry => entry.key);
const shapes = (groups: readonly ProcessGroup[]): string[][] => groups.map(group => group.entries.map(entry => entry.kind));
const snapshot = (items: TimelineViewItem[]): PresentationSnapshot => {
  const view = projectTimeline(items);
  return view;
};

describe("processGroups 边界", () => {
  test("G01 同一轮相邻 Thinking 与 Tool 合组且顺序不变", () => {
    const list = entriesOf([thinking("t1"), tool("a"), thinking("t2"), tool("b")]);
    const groups = groupsOf(list);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.groupId).toBe("g1");
    expect(groups[0]!.entries).toEqual(list);
    // 首次分组的身份由首成员稳定 key 派生，不用下标、文本或时间。
    expect(groups[0]!.key).toBe(`process:${list[0]!.key}`);
  });

  test("G02 窗口中间插入正文时保持两组且正文原位", () => {
    const list = entriesOf([thinking("t1"), text("body"), tool("a")]);
    const groups = groupsOf(list);
    expect(shapes(groups)).toEqual([["thinking"], ["tool"]]);
    expect(list[1]).toMatchObject({ kind: "text", text: "body" });
    expect(groups[0]!.entries[0]).toBe(list[0]);
    expect(groups[1]!.entries[0]).toBe(list[2]);
  });

  test.each([
    ["用户消息", user, "record"],
    ["已发布文件", file, "record"],
    ["摘要记录", summary, "record"],
    ["run_end", runEnd, "record"],
  ])("G03 %s 断组并保留记录", (_label, record, kind) => {
    const list = entriesOf([thinking("t1"), record, tool("a")]);
    expect(list[1]!.kind).toBe(kind);
    expect(shapes(groupsOf(list))).toEqual([["thinking"], ["tool"]]);
  });

  test("G04 不同 group_id 不合组", () => {
    const list = entriesOf([thinking("t1", "g1"), tool("a", "g2"), tool("b", "g2"), thinking("t2", "g1")]);
    const groups = groupsOf(list);
    expect(shapes(groups)).toEqual([["thinking"], ["tool", "tool"], ["thinking"]]);
    expect(groups.map(group => group.groupId)).toEqual(["g1", "g2", "g1"]);
  });

  test("G05 断组 key 表示该成员之前断开，四种过程相邻组合都生效", () => {
    const pairs: [TimelineViewItem, TimelineViewItem][] = [
      [thinking("t1"), thinking("t2")],
      [thinking("t1"), tool("a")],
      [tool("a"), thinking("t1")],
      [tool("a"), tool("b")],
    ];
    for (const pair of pairs) {
      const list = entriesOf(pair);
      expect(groupsOf(list)).toHaveLength(1);
      expect(groupsOf(list, new Set([list[1]!.key]))).toHaveLength(2);
    }
  });

  test("G06 空 Thinking、失败工具与仍在运行的工具都保留为成员", () => {
    const list = entriesOf([thinking("empty", "g1", ""), tool("bad", "g1", "error"), runningTool("live")]);
    expect(list[0]).toMatchObject({ kind: "thinking", text: "", streaming: false });
    const groups = groupsOf(list);
    expect(shapes(groups)).toEqual([["thinking", "tool", "tool"]]);
  });
});

describe("processGroups 身份", () => {
  test("G07 向前补齐更早历史不改变已有组 key", () => {
    const first = snapshot([tool("b"), tool("c")]);
    const groups = groupsOf(first.entries);
    const nextItems = [tool("a"), tool("b"), tool("c")];
    const next = projectTimeline(nextItems, first);
    const after = groupsOf(next.entries, new Set(), groups);
    expect(next.entries[0]!.key).not.toBe(first.entries[0]!.key);
    expect(after).toHaveLength(1);
    expect(after[0]!.key).toBe(groups[0]!.key);
    expect(after[0]!.entries).toHaveLength(3);
  });

  test("G08 partial 转正式结果与 leaf 推进保持成员、组和选择", () => {
    const first = snapshot([runningTool("a")]);
    const groups = groupsOf(first.entries);
    const choices = withProcessExpansion(new Map(), members(groups[0]!), true);
    const settled = projectTimeline([{ kind: "event", event: { ...toolEvent("a"), leaf_id: "next" } }], first);
    const after = groupsOf(settled.entries, new Set(), groups);
    expect(settled.entries[0]!.key).toBe(first.entries[0]!.key);
    expect(after[0]!.key).toBe(groups[0]!.key);
    expect(members(after[0]!)).toEqual(members(groups[0]!));
    expect(processExpansion(after[0]!.entries, choices)).toEqual({ expanded: true, order: 1 });
  });

  test("G09 并行工具逆序完成不重排成员", () => {
    const first = snapshot([runningTool("a"), runningTool("b")]);
    const groups = groupsOf(first.entries);
    const settled = projectTimeline([tool("b"), tool("a")], first);
    expect(settled.entries.map(entry => entry.key)).toEqual(first.entries.map(entry => entry.key));
    const after = groupsOf(settled.entries, new Set(), groups);
    expect(after[0]!.key).toBe(groups[0]!.key);
    expect(members(after[0]!)).toEqual(members(groups[0]!));
  });

  test("G12 会话切换不继承旧组与旧选择", () => {
    const first = snapshot([tool("a")]);
    const groups = groupsOf(first.entries);
    const choices = withProcessExpansion(new Map(), members(groups[0]!), true);
    const otherEntries = entriesOf([{ kind: "event", event: { ...toolEvent("a"), session_id: "other" } }]);
    const otherGroups = groupsOf(otherEntries, new Set(), groups);
    expect(otherGroups[0]!.key).not.toBe(groups[0]!.key);
    expect(otherGroups[0]!.key).toBe(`process:${otherEntries[0]!.key}`);
    expect(processExpansion(otherGroups[0]!.entries, choices)).toBeUndefined();
  });

  test("G13 原锚定成员消失后保留旧 key，多次更新与再拆分不重复", () => {
    const first = snapshot([tool("a"), tool("b")]);
    const groups = groupsOf(first.entries);
    const anchorKey = groups[0]!.key;
    expect(anchorKey).toBe(`process:${first.entries[0]!.key}`);

    const removed = projectTimeline([tool("b")], first);
    const afterRemove = groupsOf(removed.entries, new Set(), groups);
    expect(afterRemove).toHaveLength(1);
    expect(afterRemove[0]!.key).toBe(anchorKey);

    const extended = projectTimeline([tool("b"), tool("c")], removed);
    const afterExtend = groupsOf(extended.entries, new Set(), afterRemove);
    expect(afterExtend[0]!.key).toBe(anchorKey);

    const split = projectTimeline([tool("b"), text("late"), tool("c")], extended);
    const afterSplit = groupsOf(split.entries, new Set(), afterExtend);
    expect(afterSplit.map(group => group.key)).toEqual([anchorKey, `process:${afterSplit[1]!.entries[0]!.key}`]);
    expect(new Set(afterSplit.map(group => group.key)).size).toBe(afterSplit.length);
  });

  test("G13 拆分时原锚点所在部分继承，而不是按新的首项继承", () => {
    const first = snapshot([tool("b"), thinking("c")]);
    const previous = groupsOf(first.entries);
    const next = projectTimeline([thinking("a"), text("cut"), tool("b"), thinking("c")], first);
    const groups = groupsOf(next.entries, new Set(), previous);
    expect(groups).toHaveLength(2);
    expect(groups[1]!.key).toBe(previous[0]!.key);
    expect(groups[0]!.key).toBe(`process:${groups[0]!.entries[0]!.key}`);
    expect(new Set(groups.map(group => group.key)).size).toBe(2);
  });

  test("G13 已移除的原锚点从历史返回且被正文隔开时不产生 key 冲突", () => {
    const initial = groupsOf(entriesOf([tool("a"), tool("b")]));
    const withoutAnchor = groupsOf(entriesOf([tool("b")]), new Set(), initial);
    const restored = groupsOf(entriesOf([tool("a"), text("cut"), tool("b")]), new Set(), withoutAnchor);
    expect(restored).toHaveLength(2);
    expect(restored[0]!.key).toBe(initial[0]!.key);
    expect(new Set(restored.map(group => group.key)).size).toBe(2);
  });

  test("没有共同成员时不按相同正文或时间继承；不变输入复用原组", () => {
    const list = entriesOf([thinking("a", "g1", "Same text")]);
    const previous = groupsOf(list);
    expect(groupsOf(list, new Set(), previous)[0]).toBe(previous[0]);
    const replaced = entriesOf([thinking("b", "g1", "Same text")]);
    expect(groupsOf(replaced, new Set(), previous)[0]!.key).not.toBe(previous[0]!.key);
    expect(groupsOf([], new Set(), previous)).toEqual([]);
  });

  test("G10 合并保留一个旧 key，不产生重复身份", () => {
    const previousList = entriesOf([tool("a"), tool("b"), text("cut"), tool("c")]);
    const previous = groupsOf(previousList);
    expect(previous).toHaveLength(2);
    const mergedList = entriesOf([tool("a"), tool("b"), tool("c")]);
    const merged = groupsOf(mergedList, new Set(), previous);
    // 两个旧组向同一候选提出继承时，按旧组顺序确定性保留第一个。
    expect(merged).toHaveLength(1);
    expect(merged[0]!.key).toBe(previous[0]!.key);
    expect(new Set(merged.map(group => group.key)).size).toBe(merged.length);
  });

  test("每个过程成员恰好出现一次，顺序与投影一致", () => {
    const list = entriesOf([thinking("t1"), tool("a"), tool("b"), text("body"), user, thinking("t2"), tool("c"), summary, runningTool("d"), text("tail")]);
    const groups = groupsOf(list, processNoticeBreakKeys(list, []));
    expect(groups.flatMap(members)).toEqual(processKeys(list));
    expect(new Set(groups.flatMap(members)).size).toBe(groups.flatMap(members).length);
  });
});

describe("processExpansion", () => {
  test("G10 拆分后各段继承原选择，合并时最近一次操作优先", () => {
    const list = entriesOf([tool("a"), tool("b"), tool("c")]);
    const [group] = groupsOf(list);
    const whole = withProcessExpansion(new Map(), members(group!), true);
    const split = groupsOf(entriesOf([tool("a"), tool("b"), text("late"), tool("c")]));
    expect(split.map(part => processExpansion(part.entries, whole)?.expanded)).toEqual([true, true]);

    const newest = withProcessExpansion(whole, [split[1]!.entries[0]!.key], false);
    expect(processExpansion(split[0]!.entries, newest)?.expanded).toBe(true);
    expect(processExpansion(split[1]!.entries, newest)?.expanded).toBe(false);
    expect(processExpansion(groupsOf(list)[0]!.entries, newest)?.expanded).toBe(false);

    // 新成员加入已有组不覆盖旧选择。
    const extended = groupsOf(entriesOf([tool("a"), tool("b"), tool("c"), runningTool("d")]));
    expect(processExpansion(extended[0]!.entries, newest)?.expanded).toBe(false);

    const unrelated = withProcessExpansion(new Map(), [entriesOf([tool("x")])[0]!.key], true);
    expect(processExpansion(groupsOf(list)[0]!.entries, unrelated)).toBeUndefined();
  });

  test("顺序号严格大于已有选择，自动状态不写入手动选择", () => {
    const [first] = entriesOf([tool("a")]);
    const choices = withProcessExpansion(new Map(), [first!.key], true);
    const next = withProcessExpansion(choices, [first!.key], false);
    expect(next.get(first!.key)).toEqual({ expanded: false, order: 2 });
    expect(choices.get(first!.key)).toEqual({ expanded: true, order: 1 });
    expect(withProcessExpansion(new Map(), [], true).size).toBe(0);
  });
});

describe("processNoticeBreakKeys", () => {
  test("G11 提示后的第一条成员前断开，多个提示只标一次且不改输入", () => {
    const list = entriesOf([withSeq(thinking("t1"), 1), withSeq(tool("a"), 3)]);
    const afterSeqs = [2, 1];
    const keys = processNoticeBreakKeys(list, afterSeqs);
    expect(keys).toEqual(new Set([list[1]!.key]));
    expect(afterSeqs).toEqual([2, 1]);
    expect(list.map(entry => entry.seq)).toEqual([1, 3]);
    expect(groupsOf(list, keys)).toHaveLength(2);
  });

  test("提示位于过程成员之间时只断组，不移动位置或增加显示项", () => {
    const list = entriesOf([withSeq(thinking("t1"), 1), withSeq(tool("a"), 3), withSeq(thinking("t2"), 5)]);
    const keys = processNoticeBreakKeys(list, [1]);
    expect(keys).toEqual(new Set([list[1]!.key]));
    const groups = groupsOf(list, keys);
    expect(shapes(groups)).toEqual([["thinking"], ["tool", "thinking"]]);
    expect(groups.flatMap(members)).toEqual(list.map(entry => entry.key));
  });

  test("末端提示与已消费提示不生成断组", () => {
    const list = entriesOf([withSeq(thinking("t1"), 1)]);
    expect(processNoticeBreakKeys(list, [1])).toEqual(new Set());
    expect(processNoticeBreakKeys(list, [0])).toEqual(new Set([list[0]!.key]));
  });

  test("缺少 seq 的成员消费剩余提示并只标它自己", () => {
    const list = entriesOf([withSeq(thinking("t1"), 1), runningTool("a")]);
    expect(list[1]!.seq).toBeUndefined();
    expect(processNoticeBreakKeys(list, [4])).toEqual(new Set([list[1]!.key]));
  });
});
