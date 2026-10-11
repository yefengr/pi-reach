import { describe, expect, test } from "vitest";
import type { ToolValue } from "./tool-presentation";
import { GROUP_HEAD_MAX_BACKLOG, groupHeadTool, initialGroupHead, stepGroupHead, type GroupHeadElapsed, type GroupHeadState } from "./tool-group-head";

const scope = { session_id: "s", leaf_id: "l", group_id: "g" };
const running = (id: string): ToolValue => ({ ...scope, protocol_version: 2, type: "timeline_partial", partial_id: `tool:${id}`, kind: "tool", tool_call_id: id, tool: "bash", args: { command: id }, status: "running" });
const done = (id: string): ToolValue => ({ ...scope, event_id: id, timestamp: 1, kind: "tool", tool_call_id: id, tool: "bash", args: { command: id }, truncated: false, status: "complete", result: "ok" });
const fresh: GroupHeadElapsed = { queued: false, minimum: false };
const queued: GroupHeadElapsed = { queued: true, minimum: false };
const settled: GroupHeadElapsed = { queued: true, minimum: true };
const shown = (state: GroupHeadState, values: ToolValue[], elapsed: GroupHeadElapsed = fresh) => groupHeadTool(state, values, true, elapsed)?.tool_call_id ?? null;

describe("group heading queue", () => {
  test("starts from the last running tool and treats existing tools as history", () => {
    const values = [done("a"), running("b"), running("c")];
    const state = initialGroupHead(values, true);
    expect(shown(state, values)).toBe("c");
    expect(state.animate).toBe(false);
    expect(initialGroupHead([done("a")], true).index).toBe(-1);
    expect(initialGroupHead([running("a")], false).index).toBe(-1);
  });

  test("shows each new tool in start order after the current one has been visible long enough", () => {
    let values = [running("a")];
    let state = initialGroupHead(values, true);
    values = [done("a"), running("b"), done("c")];
    state = stepGroupHead(state, values, true, fresh);
    expect(shown(state, values)).toBe("a");
    state = stepGroupHead(state, values, true, queued);
    expect(shown(state, values)).toBe("b");
    expect(state.animate).toBe(true);
    // 新的一条刚进入组头，计时重新开始：未满排队停留时不前进。
    expect(stepGroupHead(state, values, true, fresh)).toBe(state);
    state = stepGroupHead(state, values, true, queued);
    // 已结束的工具同样显示一次；排在最后且停满最短停留后回到摘要。
    expect(shown(state, values, queued)).toBe("c");
    expect(shown(state, values, settled)).toBeNull();
  });

  test("skips to the latest tool when the backlog exceeds the limit", () => {
    let values = [running("a")];
    let state = initialGroupHead(values, true);
    values = [running("a"), ...Array.from({ length: GROUP_HEAD_MAX_BACKLOG + 1 }, (_, index) => running(`n${index}`))];
    state = stepGroupHead(state, values, true, fresh);
    expect(shown(state, values)).toBe(`n${GROUP_HEAD_MAX_BACKLOG}`);
  });

  test("never queues prepended history or offline tools", () => {
    let values = [running("b")];
    let state = initialGroupHead(values, true);
    values = [done("a"), running("b")];
    state = stepGroupHead(state, values, true, settled);
    expect(state.queue).toEqual([JSON.stringify(["s", "l", "g", "b"])]);
    const offline = stepGroupHead(state, [...values, running("c")], false, settled);
    expect(offline.queue).toHaveLength(1);
    expect(groupHeadTool(offline, values, false, fresh)).toBeNull();
  });
});
