import { toolIdentity, type ToolValue } from "./tool-presentation";
import { effectiveToolStatus } from "./tool-groups";

/** 后面还有排队的工具时，当前工具在组头的最短停留时间。 */
export const GROUP_HEAD_QUEUED_VISIBLE_MS = 800;
/** 排在最后的工具结束后，在组头的最短停留时间；满后回到摘要。 */
export const GROUP_HEAD_MIN_VISIBLE_MS = 1500;
/** 排队积压超过该条数时直接跳到最新开始的工具，避免组头长时间落后于实际进度。 */
export const GROUP_HEAD_MAX_BACKLOG = 3;

/**
 * 组头排队状态：`known` 为已见过的工具，`queue` 按开始顺序记录在线时新出现、需要在组头显示的工具，
 * `index` 指向当前显示的一条（-1 表示尚未显示），`animate` 表示组头出现后发生过切换。
 */
export type GroupHeadState = { known: ReadonlySet<string>; queue: readonly string[]; index: number; animate: boolean };

/** 当前显示的工具已停留的时长是否已满排队停留与最短停留。 */
export type GroupHeadElapsed = { queued: boolean; minimum: boolean };

/** 组头首次出现：已有的工具视为历史，只把仍在运行的排入队列，并直接显示最后开始的一条。 */
export function initialGroupHead(values: readonly ToolValue[], live: boolean): GroupHeadState {
  const queue = live ? values.filter(value => effectiveToolStatus(value, live) === "running").map(toolIdentity) : [];
  return { known: new Set(values.map(toolIdentity)), queue, index: queue.length - 1, animate: false };
}

/**
 * 按开始顺序推进组头：在线时追加在已知工具之后新出现的工具（向前补齐的历史不排队）；当前一条停满排队停留后换下一条，
 * 积压超过 GROUP_HEAD_MAX_BACKLOG 时直接跳到最新一条。已显示过的工具不再回到组头。没有变化时返回原状态。
 */
export function stepGroupHead(state: GroupHeadState, values: readonly ToolValue[], live: boolean, elapsed: GroupHeadElapsed): GroupHeadState {
  let known = state.known;
  let queue = state.queue;
  let lastKnown = -1;
  values.forEach((value, position) => { if (state.known.has(toolIdentity(value))) lastKnown = position; });
  values.forEach((value, position) => {
    const key = toolIdentity(value);
    if (known.has(key)) return;
    if (known === state.known) known = new Set(state.known);
    (known as Set<string>).add(key);
    if (live && position > lastKnown) queue = [...queue, key];
  });
  const backlog = queue.length - 1 - state.index;
  let index = state.index;
  if (backlog > GROUP_HEAD_MAX_BACKLOG) index = queue.length - 1;
  else if (backlog > 0 && (state.index < 0 || elapsed.queued)) index = state.index + 1;
  if (known === state.known && queue === state.queue && index === state.index) return state;
  return { known, queue, index, animate: state.animate || index !== state.index };
}

/** 组头当前显示的工具；排在最后的一条结束并停满最短停留后返回 null，组头回到摘要。 */
export function groupHeadTool(state: GroupHeadState, values: readonly ToolValue[], live: boolean, elapsed: GroupHeadElapsed): ToolValue | null {
  if (!live || state.index < 0) return null;
  const key = state.queue[state.index];
  const value = values.find(candidate => toolIdentity(candidate) === key);
  if (value === undefined) return null;
  const last = state.index === state.queue.length - 1;
  return last && effectiveToolStatus(value, live) !== "running" && elapsed.minimum ? null : value;
}
