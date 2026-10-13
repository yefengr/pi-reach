import { describe, expect, test } from "vitest";
import { toolIdentity, type ToolValue } from "./tool-presentation";
import { GROUP_HEAD_MAX_BACKLOG, GROUP_HEAD_MIN_VISIBLE_MS, GROUP_HEAD_QUEUED_VISIBLE_MS, groupHeadTool, initialGroupHead, stepGroupHead, type GroupHeadElapsed, type GroupHeadState } from "./tool-group-head";

const scope = { session_id: "s", leaf_id: "l", group_id: "g" };
const running = (id: string): ToolValue => ({ ...scope, protocol_version: 2, type: "timeline_partial", partial_id: `tool:${id}`, kind: "tool", tool_call_id: id, tool: "bash", args: { command: id }, status: "running" });
const done = (id: string): ToolValue => ({ ...scope, event_id: id, timestamp: 1, kind: "tool", tool_call_id: id, tool: "bash", args: { command: id }, truncated: false, status: "complete", result: "ok" });
const fresh: GroupHeadElapsed = { queued: false, minimum: false };
const queued: GroupHeadElapsed = { queued: true, minimum: false };
const settled: GroupHeadElapsed = { queued: true, minimum: true };
const none: ReadonlySet<string> = new Set();
const appendedOf = (...values: ToolValue[]) => new Set(values.map(toolIdentity));
const shown = (state: GroupHeadState, values: ToolValue[]) => groupHeadTool(state, values, true)?.tool_call_id ?? null;

describe("group heading queue", () => {
  test("history only queues running tools and starts from the last of them", () => {
    const values = [done("a"), running("b"), running("c")];
    const state = initialGroupHead(values, true, none);
    expect(shown(state, values)).toBe("c");
    expect(state.animate).toBe(false);
    expect(initialGroupHead([done("a")], true, none).index).toBe(-1);
    expect(initialGroupHead([running("a")], false, none).index).toBe(-1);
  });

  test("a live already finished tool stays until the batch closes and its 800ms minimum elapses", () => {
    expect(GROUP_HEAD_MIN_VISIBLE_MS).toBe(800);
    expect(GROUP_HEAD_QUEUED_VISIBLE_MS).toBe(800);
    const values = [done("a")];
    const state = initialGroupHead(values, true, appendedOf(...values));
    expect(shown(stepGroupHead(state, values, true, settled, none), values)).toBe("a");
    expect(shown(stepGroupHead(state, values, true, fresh, none, true), values)).toBe("a");
    expect(shown(stepGroupHead(state, values, true, settled, none, true), values)).toBeNull();
  });

  test("shows appended tools in start order and resets elapsed on each new head", () => {
    let values = [running("a")];
    const appended = appendedOf(running("a"), running("b"), done("c"));
    let state = initialGroupHead(values, true, appended);
    values = [done("a"), running("b"), done("c")];
    state = stepGroupHead(state, values, true, fresh, appended);
    expect(shown(state, values)).toBe("a");
    state = stepGroupHead(state, values, true, queued, appended);
    expect(shown(state, values)).toBe("b");
    expect(state.animate).toBe(true);
    expect(stepGroupHead(state, values, true, fresh, appended)).toBe(state);
    // b 已经停满，但刚切换到 c；即使边界已出现且工具全完成，也不能复用 b 的计时。
    values = values.map(value => done(value.tool_call_id));
    state = stepGroupHead(state, values, true, settled, appended, true);
    expect(shown(state, values)).toBe("c");
    expect(shown(stepGroupHead(state, values, true, fresh, none, true), values)).toBe("c");
    expect(shown(stepGroupHead(state, values, true, settled, none, true), values)).toBeNull();
  });

  test("a completed last head never becomes summary while an earlier tool is running", () => {
    let values = [running("a"), running("b")];
    const state = initialGroupHead(values, true, none);
    values = [running("a"), done("b")];
    expect(shown(stepGroupHead(state, values, true, settled, none, true), values)).toBe("b");
    values = [done("a"), done("b")];
    expect(shown(stepGroupHead(state, values, true, settled, none), values)).toBe("b");
    // 计时从进入组头起算，不从工具结束起算；已停满时可以立即转摘要。
    expect(shown(stepGroupHead(state, values, true, settled, none, true), values)).toBeNull();
  });

  test("new tools append without a summary flash while the boundary is missing", () => {
    let values = [done("a")];
    let state = initialGroupHead(values, true, appendedOf(...values));
    state = stepGroupHead(state, values, true, settled, none);
    expect(shown(state, values)).toBe("a");
    values = [...values, done("b")];
    state = stepGroupHead(state, values, true, settled, appendedOf(done("b")), true);
    expect(shown(state, values)).toBe("b");
    expect(state.summary).toBe(false);
  });

  test("a batch that entered summary never replays on appended tools or status updates", () => {
    let values = [done("a")];
    let state = initialGroupHead(values, true, appendedOf(...values));
    state = stepGroupHead(state, values, true, settled, none, true);
    expect(state.summary).toBe(true);
    values = [...values, running("b")];
    state = stepGroupHead(state, values, true, fresh, appendedOf(running("b")));
    expect(shown(state, values)).toBeNull();
    expect(state.queue).toEqual([toolIdentity(done("a"))]);
    expect(state.known.has(toolIdentity(running("b")))).toBe(true);
  });

  test("an unclosed static historical summary does not seal a live batch", () => {
    const history = [done("a")];
    let state = initialGroupHead(history, true, none);
    state = stepGroupHead(state, history, true, settled, none);
    expect(state.summary).toBe(false);
    const values = [...history, done("b")];
    state = stepGroupHead(state, values, true, settled, appendedOf(done("b")));
    expect(shown(state, values)).toBe("b");
    const closed = stepGroupHead(initialGroupHead(history, true, none), history, true, fresh, none, true);
    expect(closed.summary).toBe(true);
    expect(shown(stepGroupHead(closed, values, true, settled, appendedOf(done("b")), true), values)).toBeNull();
  });

  test("skips to the latest tool when the backlog exceeds the limit", () => {
    let values = [running("a")];
    let state = initialGroupHead(values, true, none);
    values = [running("a"), ...Array.from({ length: GROUP_HEAD_MAX_BACKLOG + 1 }, (_, index) => running(`n${index}`))];
    state = stepGroupHead(state, values, true, fresh, appendedOf(...values));
    expect(shown(state, values)).toBe(`n${GROUP_HEAD_MAX_BACKLOG}`);
  });

  test("never queues history or offline tools", () => {
    let values = [running("b")];
    let state = initialGroupHead(values, true, none);
    values = [done("a"), running("b")];
    state = stepGroupHead(state, values, true, settled, none);
    expect(state.queue).toEqual([toolIdentity(running("b"))]);
    const offline = stepGroupHead(state, [...values, running("c")], false, settled, appendedOf(running("c")));
    expect(offline.queue).toHaveLength(1);
    expect(groupHeadTool(offline, values, false)).toBeNull();
  });
});
