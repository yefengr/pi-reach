import type { TimelineEvent, TimelinePartial } from "../pi-reach/protocol-v2/schema";
import { matchesFormalMessage, partialMessageIdentity } from "./timeline-identity";
import { nonStreamTokens, partialText, sameItems, sameNonStreamTokens, type NonStreamToken } from "./stream-display-items";
import { StreamStructureGate } from "./stream-structure-gate";
import type { TimelinePartialView, TimelinePending, TimelineViewItem } from "./timeline-runtime";
import { isQueuedMessage } from "./queued-message-display";
import { readPwaMotionDuration } from "../ui/motion-duration";

const BASE_TICK_MS = 16;
/** 目标显示延迟：积压按此时长换算成放出速率，吸收上游 chunk 的到达抖动，不再放完即停。 */
const TARGET_LATENCY_MS = 240;
/** 速率平滑时间常数：新 chunk 到达时速度渐变，不随积压突变。 */
const RATE_SMOOTHING_MS = 120;
/** 速率上下限（字素/ms）：积压很少时每帧至少一个字素，突发大段时也不一帧铺满。 */
const MIN_RELEASE_PER_MS = 1 / BASE_TICK_MS;
const MAX_RELEASE_PER_MS = 64 / BASE_TICK_MS;
/**
 * 正式版本到达后，剩余积压在收尾窗口内放完再交接，避免结尾整段跳出。
 * 窗口沿用已建立的放出速率，只有新 lane 才用积压/目标延迟初始化；边界 160–640ms，
 * 低速尾巴不突增，高速尾巴不骤降。
 */
const FINISH_MIN_MS = 160;
const FINISH_MAX_MS = 640;
const INITIAL_BURST = 2;
const graphemeSegmenter = typeof Intl !== "undefined" && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

type GraphemeCursor = {
  graphemes: string[];
  visibleCount: number;
};

type StreamState = {
  thinkingTextEpoch: object;
  partial: TimelinePartialView;
  targetText: string;
  /** null 表示即时展示：正文已全部可见，不保留字素游标。 */
  cursor: GraphemeCursor | null;
  visibleText: string;
  /** 平滑后的放出速率与未满一个字素的余量。 */
  rate: number;
  credit: number;
  /** 收尾窗口内已用时长与窗口长度；只在 finishing 期间有意义。 */
  elapsedMs: number;
  finishWindowMs: number;
  /** 正在收尾时为对应正式事件 ID：正式版本暂缓显示，由本 lane 在其位置放完尾巴。 */
  finishing: string | null;
  seen: boolean;
  /**
   * 紧接过程组（思考或工具）的正文先让过程组收起，再开始逐字显示：
   * pending 尚未出现可见文字；waiting 已有文字、等待到 until；done 正常放出。
   */
  settle: { phase: "pending" } | { phase: "waiting"; until: number } | { phase: "done" };
};

export type StreamDisplayBufferChange = {
  items: TimelineViewItem[];
  shouldRender: boolean;
  /** 状态/结构变化绕过普通内容的显示提交窗口。 */
  urgent: boolean;
  hasPending: boolean;
};

function hasBlocks(partial: TimelinePartial): boolean {
  return partial.blocks !== undefined;
}

function streamsImmediately(partial: TimelinePartial): boolean {
  return partial.kind === "tool" || hasBlocks(partial);
}

function samePartialState(previous: TimelinePartial, next: TimelinePartial): boolean {
  // 参数和正文同属内容；不为判断紧急状态递归序列化可能很大的工具参数。
  if (previous.kind !== next.kind || previous.status !== next.status || previous.session_id !== next.session_id
    || previous.group_id !== next.group_id || previous.partial_id !== next.partial_id) return false;
  return previous.kind !== "tool" || next.kind === "tool"
    && previous.tool_call_id === next.tool_call_id && previous.tool === next.tool;
}

function blocksExtend(previous: TimelinePartial, next: TimelinePartial): boolean {
  const before = previous.blocks;
  const after = next.blocks;
  if (before === undefined || after === undefined || before.length > after.length) return false;
  // 每个展示条目单独解析；不能用 join 后的文本判定块边界是否保留。
  return before.every((block, index) => (block.type === "text" || block.type === "thinking")
    && after[index]?.type === block.type && after[index].text.startsWith(block.text));
}

function segmentText(text: string): string[] {
  if (graphemeSegmenter) return [...graphemeSegmenter.segment(text)].map((part) => part.segment);
  return Array.from(text);
}

/** 按需展示的初始游标：先显示少量字素，其余按原 burst 逻辑追赶。 */
function initialCursor(targetText: string): GraphemeCursor {
  const graphemes = segmentText(targetText);
  return { graphemes, visibleCount: Math.min(INITIAL_BURST, graphemes.length) };
}

function cursorText(cursor: GraphemeCursor): string {
  return cursor.graphemes.slice(0, cursor.visibleCount).join("");
}

function appendTargetGraphemes(cursor: GraphemeCursor, baseText: string, targetText: string): void {
  const suffix = targetText.slice(baseText.length);
  const lastGrapheme = cursor.graphemes.pop();
  if (lastGrapheme === undefined) {
    cursor.graphemes.push(...segmentText(suffix));
    return;
  }
  cursor.graphemes.push(...segmentText(`${lastGrapheme}${suffix}`));
}

/** 从即时展示切入按需展示：用已显示正文重建游标，不重播也不丢失已显示前缀。 */
function appendLaneText(state: StreamState, targetText: string): void {
  let cursor = state.cursor;
  if (cursor === null) {
    const graphemes = segmentText(state.visibleText);
    cursor = { graphemes, visibleCount: graphemes.length };
    state.cursor = cursor;
  }
  // 即时展示下 visibleText 恒等于 targetText，因此旧目标正文就是游标基准。
  appendTargetGraphemes(cursor, state.targetText, targetText);
  cursor.visibleCount = Math.min(cursor.visibleCount, cursor.graphemes.length);
  state.elapsedMs = 0;
}

function projectedPartial(state: StreamState): TimelinePartialView {
  const partial = hasBlocks(state.partial.partial)
    ? state.partial.partial
    : { ...state.partial.partial, delta: state.visibleText };
  const presentsThinking = (partial.kind === "assistant" || partial.kind === "thinking")
    && (partial.blocks === undefined ? partial.kind === "thinking" : partial.blocks.some(block => block.type === "thinking"));
  return { kind: "partial", createdAt: state.partial.createdAt, partial,
    ...(presentsThinking ? { thinkingTextEpoch: state.thinkingTextEpoch } : {}),
    ...(state.settle.phase === "waiting" ? { awaitingSettle: true as const } : {}),
  };
}

/**
 * 已出队、但上一轮尚未呈现完的消息：显示上仍留在排队区，标为发送中且不可管理（实际已在投递），
 * 等上一轮及其完成时间呈现后再进入对话区。
 */
function heldInQueue(item: TimelinePending): TimelinePending {
  return { ...item, queued: true, queueInFlight: false, cancelable: false, messageId: undefined };
}

/** 只呈现思考或工具的条目：其后的正文要先等过程组收起。 */
function presentsProcess(item: TimelineViewItem): boolean {
  if (item.kind === "pending") return false;
  const value = item.kind === "event" ? item.event : item.partial;
  if (value.kind === "tool" || value.kind === "thinking") return true;
  if (value.kind !== "assistant") return false;
  const blocks = value.blocks;
  // 只有思考块的消息属于过程组；含非空正文的消息本身就是正文。
  return blocks !== undefined && blocks.length > 0 && blocks.every(block => block.type === "thinking" || !block.text.trim());
}

/** 正文 partial 在权威顺序中是否紧接同一轮的过程条目；轮次开头或接在正文、记录之后的不等待。 */
function followsProcess(items: readonly TimelineViewItem[], partial: TimelinePartial): boolean {
  if (partial.kind !== "assistant" || hasBlocks(partial)) return false;
  const index = items.findIndex(item => item.kind === "partial" && item.partial.partial_id === partial.partial_id);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const item = items[cursor]!;
    if (item.kind === "pending") continue;
    const groupId = item.kind === "event" ? item.event.group_id : item.partial.group_id;
    if (groupId !== partial.group_id) return false;
    return presentsProcess(item);
  }
  return false;
}

function isDrained(state: StreamState): boolean {
  if (state.cursor === null) return state.visibleText === state.targetText;
  return state.cursor.visibleCount >= state.cursor.graphemes.length && state.visibleText === state.targetText;
}

/** 积压换算目标速率并按时间平滑；余量累计到满一个字素才放出。 */
function paceRelease(state: StreamState, backlog: number, elapsed: number): number {
  const desired = Math.min(MAX_RELEASE_PER_MS, Math.max(MIN_RELEASE_PER_MS, backlog / TARGET_LATENCY_MS));
  // 新 lane 直接取目标速率起步，之后才平滑，避免开头空等。
  state.rate = state.rate === 0 ? desired : state.rate + (desired - state.rate) * Math.min(1, elapsed / RATE_SMOOTHING_MS);
  state.credit += state.rate * elapsed;
  const release = Math.min(backlog, Math.floor(state.credit));
  state.credit -= release;
  return release;
}

/** 收尾按剩余窗口比例放出，窗口结束时必定放完。 */
function finishRelease(state: StreamState, backlog: number, elapsed: number): number {
  // 零时长 tick 不得推进：不释放、不积分。
  if (elapsed <= 0) return 0;
  const remaining = Math.max(1, state.finishWindowMs - state.elapsedMs);
  if (elapsed >= remaining) {
    // 到达收尾截止：按原限时语义一次性放完当前积压，吸收浮点尾差。
    state.credit = 0;
    state.elapsedMs += elapsed;
    return backlog;
  }
  const dt = Math.min(elapsed, remaining);
  // 指数接速：按完整剩余窗口求目标速率，并以 RATE_SMOOTHING_MS 逼近，避免末段线性翻倍。
  const debt = Math.max(0, backlog - state.credit);
  const memory = RATE_SMOOTHING_MS * (1 - Math.exp(-remaining / RATE_SMOOTHING_MS));
  const desired = Math.max(state.rate, (debt - state.rate * memory) / (remaining - memory));
  const decay = Math.exp(-dt / RATE_SMOOTHING_MS);
  const area = RATE_SMOOTHING_MS * (1 - decay);
  const budget = desired * dt + (state.rate - desired) * area;
  const nextRate = desired + (state.rate - desired) * decay;
  state.credit += Math.max(0, budget);
  state.rate = nextRate;
  state.elapsedMs += elapsed;
  const release = Math.min(backlog, Math.floor(state.credit));
  state.credit -= release;
  return release;
}

/** 正式版本中与 partial 对应的块正文；无法对应时不收尾。 */
function formalBlockText(partial: TimelinePartial, event: TimelineEvent): string | undefined {
  if (event.kind !== "assistant" || partial.kind === "tool") return undefined;
  const identity = partialMessageIdentity(partial);
  const block = identity ? event.blocks[identity.contentIndex] : undefined;
  const type = partial.kind === "thinking" ? "thinking" : "text";
  return block?.type === type ? block.text : undefined;
}

function contentIndex(state: StreamState): number {
  return partialMessageIdentity(state.partial.partial)?.contentIndex ?? 0;
}

/**
 * Projects authoritative timeline snapshots into a paced display snapshot.
 * The runtime remains authoritative; this class only owns the transient display cursor.
 */
export class StreamDisplayBuffer {
  private authoritative: TimelineViewItem[] = [];
  private displayed: TimelineViewItem[] = [];
  private renderedNonStreamTokens: NonStreamToken[] = [];
  private readonly streams = new Map<string, StreamState>();
  private readonly gate = new StreamStructureGate();
  /**
   * 上次显示快照中的本端消息、其最近的权威版本，以及当时是否位于排队区。
   * 正式用户消息接管后 Runtime 会删除该 pending；其用户消息仍在显示队列中等待时，以这里保留的版本继续显示。
   */
  private pendingShown: ReadonlyMap<string, { original: TimelinePending; queued: boolean }> = new Map();
  /** 上次构建快照时是否处于轮次交接；结束时即使没有新条目放出也要重建，让暂缓的出队进入对话区。 */
  private builtHandoff = false;
  /** 上次快照以出队副本代替了正式用户消息：下一次必须重建，换回用户消息并沿用同一气泡。 */
  private ghostHandoff = false;

  ingest(authoritative: readonly TimelineViewItem[]): StreamDisplayBufferChange {
    const previous = this.displayed;
    this.authoritative = [...authoritative];
    const formalEvents = this.formalEvents();
    const currentPartials = new Map(
      this.authoritative
        .filter((item): item is TimelinePartialView => item.kind === "partial")
        .map((item) => [item.partial.partial_id, item]),
    );
    let urgent = !sameNonStreamTokens(this.renderedNonStreamTokens, nonStreamTokens(this.authoritative));
    let needsSnapshot = urgent;

    for (const state of this.streams.values()) state.seen = false;
    for (const partial of currentPartials.values()) {
      const changed = this.ingestPartial(partial);
      needsSnapshot ||= changed.needsSnapshot;
      urgent ||= changed.urgent;
    }

    for (const event of formalEvents) {
      if (this.beginFinish(event)) needsSnapshot = true;
    }
    for (const [id, state] of this.streams) {
      const formal = formalEvents.some((event) => matchesFormalMessage(state.partial.partial, event));
      // 收尾中的 lane 只在正式版本仍存在时保留；其余由正式版本立即接管，不重播已显示文字。
      if (state.finishing !== null && formal) continue;
      if (state.finishing !== null || !state.seen || formal) {
        this.streams.delete(id);
        needsSnapshot = true;
        urgent = true;
      }
    }
    if (this.gate.plan(this.authoritative, this.laneBusy)) needsSnapshot = true;
    if (this.gate.holdsTurnHandoff() !== this.builtHandoff || this.ghostHandoff) needsSnapshot = true;

    if (!needsSnapshot) return this.unchanged();
    return { ...this.rebuild(previous, true), urgent };
  }

  /**
   * 正式版本到达时仍有积压，则暂缓接管：同一消息的全部 lane 在其位置按收尾窗口放完后再交接。
   * 正式正文与已显示前缀不一致时不收尾，直接由正式版本接管。
   */
  private beginFinish(event: TimelineEvent): boolean {
    const lanes = [...this.streams.values()].filter((state) => matchesFormalMessage(state.partial.partial, event));
    if (lanes.length === 0 || lanes.every((state) => state.finishing === event.event_id)) return false;
    const texts = lanes.map((state) => formalBlockText(state.partial.partial, event));
    const extendsShown = lanes.every((state, index) => texts[index]?.startsWith(state.targetText) === true);
    const pending = lanes.some((state, index) => state.cursor !== null && (!isDrained(state) || texts[index] !== state.targetText));
    if (!extendsShown || !pending) return false;
    lanes.forEach((state, index) => {
      const text = texts[index]!;
      state.finishing = event.event_id;
      if (text !== state.targetText) {
        if (state.cursor === null) state.visibleText = text;
        else appendLaneText(state, text);
        state.targetText = text;
      }
      state.elapsedMs = 0;
      const backlog = state.cursor === null ? 0 : state.cursor.graphemes.length - state.cursor.visibleCount;
      // 收尾沿用已建立的放出速率：低速不突增，高速不骤降；仅新 lane 用积压换算初始化。
      const finishRate = state.rate > 0
        ? state.rate
        : Math.min(MAX_RELEASE_PER_MS, Math.max(MIN_RELEASE_PER_MS, backlog / TARGET_LATENCY_MS));
      if (state.rate === 0) state.rate = finishRate;
      // 已累计未放出的 credit 计入余量，窗口按有效待释放量换算并保持 160–640ms 边界。
      state.finishWindowMs = Math.min(FINISH_MAX_MS, Math.max(FINISH_MIN_MS, Math.max(0, backlog - state.credit) / finishRate));
      state.seen = true;
    });
    return true;
  }

  private ingestPartial(partial: TimelinePartialView): { needsSnapshot: boolean; urgent: boolean } {
    const id = partial.partial.partial_id;
    const targetText = partialText(partial.partial);
    const existing = this.streams.get(id);
    const immediate = streamsImmediately(partial.partial);
    if (!existing) {
      const cursor = immediate ? null : initialCursor(targetText);
      const settles = cursor !== null && followsProcess(this.authoritative, partial.partial);
      // 等待收起的正文不预先放出起步字素，等待结束后从第一个字开始。
      if (settles) cursor.visibleCount = 0;
      this.streams.set(id, {
        thinkingTextEpoch: {}, partial, targetText, cursor,
        visibleText: cursor === null ? targetText : cursorText(cursor),
        rate: 0, credit: 0, elapsedMs: 0, finishWindowMs: FINISH_MIN_MS, finishing: null, seen: true,
        settle: { phase: settles ? "pending" : "done" },
      });
      return { needsSnapshot: true, urgent: true };
    }
    const targetChanged = existing.targetText !== targetText;
    const modeChanged = partial.partial.kind !== existing.partial.partial.kind || hasBlocks(partial.partial) !== hasBlocks(existing.partial.partial);
    const textExtends = !hasBlocks(partial.partial) && (!targetChanged || targetText.startsWith(existing.targetText));
    const appendOnly = !modeChanged && (hasBlocks(partial.partial)
      ? blocksExtend(existing.partial.partial, partial.partial) : textExtends);
    // 新 block（包括空思考块）是结构变化，纯块正文增长则合并提交。
    const urgent = !appendOnly || !samePartialState(existing.partial.partial, partial.partial)
      || partial.partial.blocks?.length !== existing.partial.partial.blocks?.length;
    const argsChanged = existing.partial.partial.kind === "tool" && partial.partial.kind === "tool"
      && existing.partial.partial.args !== partial.partial.args;
    let needsSnapshot = urgent || argsChanged;
    if (!appendOnly) existing.thinkingTextEpoch = {};
    if (targetChanged && immediate) {
      // 即时展示不建立字素游标，也无需分割全文。
      existing.cursor = null;
      existing.visibleText = targetText;
      existing.elapsedMs = 0;
      existing.settle = { phase: "done" };
      needsSnapshot = true;
    } else if (targetChanged && textExtends) {
      appendLaneText(existing, targetText);
    } else if (targetChanged) {
      const cursor = initialCursor(targetText);
      if (existing.settle.phase !== "done") cursor.visibleCount = 0;
      existing.cursor = cursor;
      existing.visibleText = cursorText(cursor);
      existing.elapsedMs = 0;
      needsSnapshot = true;
    } else if (immediate && !streamsImmediately(existing.partial.partial)) {
      existing.cursor = null;
      existing.visibleText = targetText;
      existing.elapsedMs = 0;
      existing.settle = { phase: "done" };
      needsSnapshot = true;
    }
    existing.targetText = targetText;
    existing.partial = partial;
    existing.seen = true;
    return { needsSnapshot, urgent };
  }

  reset(authoritative: readonly TimelineViewItem[]): StreamDisplayBufferChange {
    const previous = this.displayed;
    this.authoritative = [...authoritative];
    this.streams.clear();
    this.gate.reset(this.authoritative);
    const partials = this.authoritative.filter((item): item is TimelinePartialView => item.kind === "partial");
    for (const partial of partials) {
      const targetText = partialText(partial.partial);
      // 重置直接接管最新正文，不保留游标也不分割全文。
      this.streams.set(partial.partial.partial_id, {
        thinkingTextEpoch: {},
        partial,
        targetText,
        cursor: null,
        visibleText: targetText,
        rate: 0,
        credit: 0,
        elapsedMs: 0,
        finishWindowMs: FINISH_MIN_MS,
        finishing: null,
        seen: true,
        settle: { phase: "done" },
      });
    }
    const formalEvents = this.formalEvents();
    for (const [id, state] of this.streams) {
      if (formalEvents.some((event) => matchesFormalMessage(state.partial.partial, event))) this.streams.delete(id);
    }
    return this.rebuild(previous, true);
  }

  snapshot(): TimelineViewItem[] {
    return [...this.displayed];
  }

  /** 前台恢复直接接管最新权威正文，不重播后台尾巴。 */
  flush(): StreamDisplayBufferChange {
    return this.reset(this.authoritative);
  }

  advance(elapsedMs = BASE_TICK_MS): StreamDisplayBufferChange {
    const previous = this.displayed;
    const elapsed = Math.max(0, elapsedMs);
    this.gate.tick(elapsed);
    let changed = false;
    for (const state of this.streams.values()) {
      const cursor = state.cursor;
      // 排队中的新行尚未显示，不提前消耗其文字。
      if (cursor === null || !this.laneReleased(state)) continue;
      const settle = this.settleLane(state);
      if (settle === "start" || settle === "end") changed = true;
      if (settle !== "release") continue;
      const backlog = cursor.graphemes.length - cursor.visibleCount;
      if (backlog > 0) {
        const release = state.finishing === null ? paceRelease(state, backlog, elapsed) : finishRelease(state, backlog, elapsed);
        if (release <= 0) continue;
        cursor.visibleCount = Math.min(cursor.graphemes.length, cursor.visibleCount + release);
        state.visibleText = cursorText(cursor);
        changed = true;
      } else {
        state.credit = 0;
        const expected = cursorText(cursor);
        if (state.visibleText !== expected) {
          state.visibleText = expected;
          changed = true;
        }
      }
    }
    if (this.completeFinished()) changed = true;
    if (this.gate.plan(this.authoritative, this.laneBusy)) changed = true;
    if (this.gate.holdsExpired()) changed = true;
    if (this.gate.holdsTurnHandoff() !== this.builtHandoff || this.ghostHandoff) changed = true;
    if (!changed) return this.unchanged();
    return this.rebuild(previous, true);
  }

  /**
   * 紧接过程组的正文：首个非空白字到达时进入等待，期间不放出文字，投影带等待标记让过程组先自动收起；
   * 等待时长取 `--pwa-duration-collapse-settle`；结束时放出到第一个可见字（含起步字素），
   * 正文行与等待标记在同一快照交接，过程组不会因正文短暂消失而重新展开。
   * 返回 start／end（等待开始或结束，投影需要更新）、hold（等待中，本次不放出）或 release（照常放出）。
   */
  private settleLane(state: StreamState): "start" | "hold" | "end" | "release" {
    const settle = state.settle;
    if (settle.phase === "done") return "release";
    if (settle.phase === "waiting") {
      if (this.gate.now() < settle.until) return "hold";
      state.settle = { phase: "done" };
      const cursor = state.cursor!;
      const firstVisible = cursor.graphemes.findIndex(grapheme => grapheme.trim() !== "");
      cursor.visibleCount = Math.max(cursor.visibleCount, Math.min(cursor.graphemes.length, Math.max(0, firstVisible) + INITIAL_BURST));
      state.visibleText = cursorText(cursor);
      return "end";
    }
    // 只有空白时照常放出：空白不形成正文行，也不触发收起。
    if (!state.targetText.trim()) return "release";
    state.settle = { phase: "waiting", until: this.gate.now() + readPwaMotionDuration("--pwa-duration-collapse-settle") };
    return "start";
  }

  /** 同一正式事件的全部 lane 放完后一起交接。 */
  private completeFinished(): boolean {
    const finishing = new Map<string, StreamState[]>();
    for (const state of this.streams.values()) {
      if (state.finishing !== null) finishing.set(state.finishing, [...finishing.get(state.finishing) ?? [], state]);
    }
    let completed = false;
    for (const lanes of finishing.values()) {
      if (!lanes.every(isDrained)) continue;
      for (const state of lanes) this.streams.delete(state.partial.partial.partial_id);
      completed = true;
    }
    return completed;
  }

  hasPending(): boolean {
    return [...this.streams.values()].some((state) => !isDrained(state))
      || this.gate.waiting(this.authoritative) || this.gate.holdingTools() || this.gate.holdsTurnHandoff() || this.ghostHandoff;
  }

  /** 已显示的条目是否仍在放文字（含收尾 lane），供结构门控判断后续新行能否放出。 */
  private readonly laneBusy = (item: TimelineViewItem): boolean => {
    if (item.kind === "partial") {
      const state = this.streams.get(item.partial.partial_id);
      return state !== undefined && state.finishing === null && !isDrained(state);
    }
    if (item.kind !== "event") return false;
    return [...this.streams.values()].some((state) => state.finishing === item.event.event_id);
  };

  private laneReleased(state: StreamState): boolean {
    return this.gate.isReleased(state.finishing ?? state.partial.partial.partial_id);
  }

  private formalEvents(): TimelineEvent[] {
    return this.authoritative
      .filter((item): item is Extract<TimelineViewItem, { kind: "event" }> => item.kind === "event")
      .map((item) => item.event);
  }

  private buildSnapshot(): TimelineViewItem[] {
    this.gate.beginBuild();
    const handoff = this.gate.holdsTurnHandoff();
    this.builtHandoff = handoff;
    // 保留运行态顺序；主机 timestamp 和浏览器 createdAt 不能用于跨端比较。排队中的新行暂不显示。
    const visible = this.authoritative.flatMap((item): TimelineViewItem[] => {
      if (item.kind === "pending" && handoff && this.pendingShown.get(item.id)?.queued === true && !isQueuedMessage(item)) return [heldInQueue(item)];
      if (!this.gate.visible(item)) return [];
      if (item.kind === "event") {
        // 收尾中的正式版本由对应 lane 原位代替，按内容顺序排列。
        const lanes = [...this.streams.values()].filter((state) => state.finishing === item.event.event_id);
        // 工具在最短运行展示期内仍显示进行中视图，到期后才交接正式结果。
        return lanes.length ? lanes.sort((a, b) => contentIndex(a) - contentIndex(b)).map(projectedPartial) : [this.gate.toolView(item)];
      }
      if (item.kind !== "partial") return [item];
      const state = this.streams.get(item.partial.partial_id);
      return state && state.finishing === null ? [this.gate.toolView(projectedPartial(state))] : [];
    });
    const items = this.withDequeuedGhosts(visible, handoff);
    const latest = new Map(this.authoritative.flatMap(item => item.kind === "pending" ? [[item.id, item] as const] : []));
    this.pendingShown = new Map(items.flatMap(item => item.kind !== "pending" ? [] : [[item.id, {
      original: latest.get(item.id) ?? this.pendingShown.get(item.id)?.original ?? item,
      queued: isQueuedMessage(item),
    }] as const]));
    return items;
  }

  /**
   * 已被正式用户消息接管而从权威快照移除、但上次仍显示的本端消息：
   * - 其用户消息仍在显示队列中等待（或排队区的消息处于轮次交接）时，继续按原位置显示，避免气泡短暂消失；
   * - 用户消息放出时，原先在对话区的直接换为用户消息，展示层按消息 ID 沿用同一气泡；原先在排队区的
   *   先以已出队副本代替该用户消息（出队跟随照常识别），下一次快照再换回。同一快照里两者并存会显示为两个气泡。
   */
  private withDequeuedGhosts(items: readonly TimelineViewItem[], handoff: boolean): TimelineViewItem[] {
    this.ghostHandoff = false;
    const present = new Set(this.authoritative.flatMap(item => item.kind === "pending" ? [item.id] : []));
    const userIds = (source: readonly TimelineViewItem[]) => new Set(source.flatMap(item => item.kind === "event" && item.event.kind === "user" ? [item.event.message_id] : []));
    const visibleUsers = userIds(items);
    const arrivedUsers = userIds(this.authoritative);
    const held: TimelinePending[] = [];
    const released = new Map<string, TimelinePending>();
    for (const [id, { original, queued }] of this.pendingShown) {
      if (present.has(id)) continue;
      const messageId = original.messageId;
      if (messageId !== undefined && visibleUsers.has(messageId)) {
        if (queued) released.set(messageId, { ...original, queued: false, queueInFlight: true });
      } else if ((queued && handoff) || (messageId !== undefined && arrivedUsers.has(messageId))) {
        held.push(queued ? heldInQueue(original) : original);
      }
    }
    const result = items.map(item => {
      const ghost = item.kind === "event" && item.event.kind === "user" ? released.get(item.event.message_id) : undefined;
      if (ghost === undefined) return item;
      this.ghostHandoff = true;
      return ghost;
    });
    return [...result, ...held];
  }

  private rebuild(previous: readonly TimelineViewItem[], forceRender: boolean): StreamDisplayBufferChange {
    this.displayed = this.buildSnapshot();
    this.renderedNonStreamTokens = nonStreamTokens(this.authoritative);
    return this.change(previous, forceRender);
  }

  private unchanged(): StreamDisplayBufferChange {
    return { items: this.snapshot(), shouldRender: false, urgent: false, hasPending: this.hasPending() };
  }

  private change(previous: readonly TimelineViewItem[], forceRender: boolean): StreamDisplayBufferChange {
    return {
      items: this.snapshot(),
      shouldRender: forceRender || !sameItems(previous, this.displayed),
      urgent: false,
      hasPending: this.hasPending(),
    };
  }
}
