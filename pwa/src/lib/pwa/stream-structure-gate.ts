import type { TimelineEvent, TimelinePartial } from "../pi-reach/protocol-v2/schema";
import { itemId } from "./stream-display-items";
import { matchesFormalMessage } from "./timeline-identity";
import type { TimelinePartialView, TimelineViewItem } from "./timeline-runtime";

/** 同一轮新出现的行（过程组成员、正文、正式记录）之间的最小间隔，避免一帧插入多行。 */
export const STRUCTURE_GAP_MS = 120;
/** 队首等待超过该时长时取消间隔逐帧追赶，界面不长期落后于真实进度。 */
export const STRUCTURE_MAX_LAG_MS = 1000;
/** 单次到达的新行超过该数量视为补齐（重连、补拉、恢复），整体放出不排队。 */
export const STRUCTURE_BULK_LIMIT = 6;
/** 工具以运行或准备中呈现后，至少保持该时长再显示结果，快速调用也有可感知的运行态。 */
export const TOOL_MIN_RUNNING_MS = 300;

/** 条目在显示中是否仍有未放完的内容（正文 lane 或收尾 lane）。 */
export type LaneBusy = (item: TimelineViewItem) => boolean;

function groupOf(item: TimelineViewItem): string | undefined {
  if (item.kind === "event") return item.event.group_id;
  if (item.kind === "partial") return item.partial.group_id;
  return undefined;
}

function isRunEnd(item: TimelineViewItem): boolean {
  return item.kind === "event" && item.event.kind === "run_end";
}

/**
 * 显示队列的结构门控：权威快照立即进入，正在观看的一轮里新出现的行按事件顺序逐个放出，
 * 前一段文字未放完时后续行不插队；`run_end` 在本轮全部内容呈现后才放出。
 * 只决定「何时显示」，不改变条目内容或顺序；初次载入、补齐、pending 与其他轮次不排队。
 */
export class StreamStructureGate {
  private clock = 0;
  private seeded = false;
  private readonly released = new Set<string>();
  /** 已放出的 partial：其正式版本到达时属于原位接管，不再作为新行排队。 */
  private readonly releasedPartials = new Map<string, TimelinePartial>();
  private readonly arrivedAt = new Map<string, number>();
  private lastStructureAt = -Infinity;
  /** 工具进行中首次呈现的时间与最后呈现的进行中视图，供最短运行展示期间代替正式结果。 */
  private readonly toolShown = new Map<string, { at: number; view: TimelinePartialView }>();
  /** 上次构建快照时仍在保持期、由进行中视图代替正式结果的工具。 */
  private readonly held = new Set<string>();

  now(): number {
    return this.clock;
  }

  tick(elapsedMs: number): void {
    this.clock += Math.max(0, elapsedMs);
  }

  /** 重置、前台恢复与本端发送：当前全部条目立即可见，不保留排队与运行保持。 */
  reset(items: readonly TimelineViewItem[]): void {
    this.seeded = true;
    this.released.clear();
    this.releasedPartials.clear();
    this.arrivedAt.clear();
    this.toolShown.clear();
    this.held.clear();
    this.lastStructureAt = -Infinity;
    for (const item of items) this.release(item);
  }

  visible(item: TimelineViewItem): boolean {
    return this.released.has(itemId(item));
  }

  isReleased(id: string): boolean {
    return this.released.has(id);
  }

  /** 是否仍有排队的新行；`run_end` 等待也算，调度需继续推进。 */
  waiting(items: readonly TimelineViewItem[]): boolean {
    return items.some(item => !this.released.has(itemId(item)));
  }

  /** 上次构建快照时是否有工具处于最短运行展示期。 */
  holdingTools(): boolean {
    return this.held.size > 0;
  }

  /** 是否有保持期在此刻到期：到期需要重新构建快照交接正式结果。 */
  holdsExpired(): boolean {
    for (const id of this.held) {
      const shown = this.toolShown.get(id);
      if (!shown || this.clock - shown.at >= TOOL_MIN_RUNNING_MS) return true;
    }
    return false;
  }

  /** 构建快照前调用：清理保持状态，随后由 `toolView` 重新登记仍在保持的工具。 */
  beginBuild(): void {
    this.held.clear();
  }

  /** 工具 partial 呈现时登记进行中视图；正式结果在保持期内由该视图代替。 */
  toolView(item: TimelineViewItem): TimelineViewItem {
    if (item.kind === "partial" && item.partial.kind === "tool") {
      const shown = this.toolShown.get(item.partial.tool_call_id);
      this.toolShown.set(item.partial.tool_call_id, { at: shown?.at ?? this.clock, view: item });
      return item;
    }
    if (item.kind !== "event" || item.event.kind !== "tool") return item;
    const shown = this.toolShown.get(item.event.tool_call_id);
    if (!shown || shown.view.partial.group_id !== item.event.group_id) return item;
    if (this.clock - shown.at >= TOOL_MIN_RUNNING_MS) {
      this.toolShown.delete(item.event.tool_call_id);
      return item;
    }
    this.held.add(item.event.tool_call_id);
    return shown.view;
  }

  /** 保持期内的正式工具结果仍算未放完，后续新行与 `run_end` 等待它交接。 */
  private toolHeld(item: TimelineViewItem): boolean {
    if (item.kind !== "event" || item.event.kind !== "tool") return false;
    const shown = this.toolShown.get(item.event.tool_call_id);
    return shown !== undefined && this.clock - shown.at < TOOL_MIN_RUNNING_MS;
  }

  /**
   * 按权威顺序决定本次放出哪些条目；返回是否有新放出的条目。
   * `busy` 由 lane 所有者提供：已放出条目仍在放文字时，其后的新行等待。
   */
  plan(items: readonly TimelineViewItem[], busy: LaneBusy): boolean {
    this.prune(items);
    if (!this.seeded) {
      this.reset(items);
      return items.length > 0;
    }
    const live = items.findLast(item => groupOf(item) !== undefined);
    const liveGroup = live === undefined ? undefined : groupOf(live);
    // 只排队追加在本轮已显示条目之后的新行；插在其前的（历史前插、补齐）直接显示。
    const lastShown = items.findLastIndex(item => groupOf(item) === liveGroup && this.released.has(itemId(item)));
    let changed = false;
    const candidates: TimelineViewItem[] = [];
    let arrivals = 0;
    for (const [index, item] of items.entries()) {
      const id = itemId(item);
      if (this.released.has(id)) continue;
      if (!this.gated(item, liveGroup, lastShown >= 0 && (index > lastShown || isRunEnd(item)))) {
        this.release(item);
        changed = true;
        continue;
      }
      if (!this.arrivedAt.has(id)) {
        this.arrivedAt.set(id, this.clock);
        arrivals += 1;
      }
      candidates.push(item);
    }
    if (candidates.length === 0) return changed;
    if (arrivals > STRUCTURE_BULK_LIMIT) {
      for (const item of candidates) this.release(item);
      return true;
    }
    const pending = new Set(candidates);
    const held = (item: TimelineViewItem) => busy(item) || this.toolHeld(item);
    for (const item of items) {
      if (!pending.has(item)) {
        // 已放出的同轮条目仍在放文字或保持运行态：其后的新行等待，保证出现顺序与事件顺序一致。
        if (groupOf(item) === liveGroup && this.released.has(itemId(item)) && held(item)) break;
        continue;
      }
      if (isRunEnd(item)) {
        // 运行结束标记在本轮其他内容全部呈现后放出；partial 位于正式事件之后，须检查整组而非前缀。
        const settled = items.every(other => other === item || groupOf(other) !== liveGroup
          || (this.released.has(itemId(other)) && !held(other)));
        if (!settled) continue;
      }
      const lagging = this.clock - (this.arrivedAt.get(itemId(item)) ?? this.clock) >= STRUCTURE_MAX_LAG_MS;
      if (!lagging && this.clock - this.lastStructureAt < STRUCTURE_GAP_MS) break;
      this.release(item);
      this.lastStructureAt = this.clock;
      changed = true;
      // 新 lane 从少量字素起步，放完前不放出后续新行。
      if (busy(item)) break;
    }
    return changed;
  }

  /** 正在观看的一轮里追加的、不属于原位接管的新条目才排队；本端 pending 与用户消息立即显示。 */
  private gated(item: TimelineViewItem, liveGroup: string | undefined, appended: boolean): boolean {
    if (item.kind === "pending" || !appended) return false;
    if (item.kind === "event" && item.event.kind === "user") return false;
    if (groupOf(item) !== liveGroup) return false;
    return item.kind === "partial" || !this.takesOver(item.event);
  }

  private takesOver(event: TimelineEvent): boolean {
    for (const partial of this.releasedPartials.values()) {
      if (matchesFormalMessage(partial, event)) return true;
    }
    return false;
  }

  private release(item: TimelineViewItem): void {
    const id = itemId(item);
    this.released.add(id);
    this.arrivedAt.delete(id);
    if (item.kind === "partial") this.releasedPartials.set(item.partial.partial_id, item.partial);
  }

  /** 只保留仍在权威快照中的状态；已被正式版本接管的 partial 随正式事件放出后移除。 */
  private prune(items: readonly TimelineViewItem[]): void {
    const present = new Set(items.map(itemId));
    for (const id of this.released) if (!present.has(id)) this.released.delete(id);
    for (const id of this.arrivedAt.keys()) if (!present.has(id)) this.arrivedAt.delete(id);
    const events = items.flatMap(item => item.kind === "event" ? [item.event] : []);
    for (const [id, partial] of this.releasedPartials) {
      if (present.has(id)) continue;
      // 正式版本已到达但尚未放出时保留，用于判定原位接管；其余（已接管或被撤回）即可移除。
      const takeover = events.find(event => matchesFormalMessage(partial, event));
      if (takeover !== undefined && !this.released.has(takeover.event_id)) continue;
      this.releasedPartials.delete(id);
    }
    const tools = new Set(items.flatMap(item => item.kind === "partial" && item.partial.kind === "tool" ? [item.partial.tool_call_id]
      : item.kind === "event" && item.event.kind === "tool" ? [item.event.tool_call_id] : []));
    for (const id of this.toolShown.keys()) if (!tools.has(id)) this.toolShown.delete(id);
  }
}
