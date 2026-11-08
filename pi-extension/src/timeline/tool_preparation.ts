import type { ToolSummary } from "@pi-reach/protocol/session";
import { toolSummary } from "./tool_summary.js";

/** 参数生成期间的发布间隔：首帧立即发布，之后每个调用最多每 100ms 一帧，避免逐 token 刷帧。 */
export const TOOL_PREPARATION_THROTTLE_MS = 100;
export const TOOL_PREPARATION_STRING_CHARS = 512;
export type PreparingCall = Readonly<{ id: string; tool: string; summary: ToolSummary }>;

type Slot = { latest: PreparingCall; lastAt: number; timer: ReturnType<typeof setTimeout> | null };

/** 从 SDK 的 toolCall 内容块取出可发布的调用；ID 或名称尚未到达时返回 null，等后续增量补齐。 */
export function preparingCall(block: unknown): PreparingCall | null {
  if (!block || typeof block !== "object") return null;
  const call = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
  if (call.type !== "toolCall" || typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !call.name) return null;
  return { id: call.id, tool: call.name, summary: toolSummary(call.name, call.arguments) };
}

/**
 * 模型生成工具调用期间的「准备中」发布节流。
 * 调用开始执行（或被关闭）后，其尚未发出的准备帧被丢弃，之后的准备更新也被忽略，
 * 不会让迟到的准备帧覆盖运行状态。
 */
export class ToolPreparation {
  private readonly slots = new Map<string, Slot>();
  private readonly closed = new Set<string>();

  constructor(
    private readonly publish: (call: PreparingCall) => void,
    private readonly now: () => number = Date.now,
  ) {}

  isClosed(id: string): boolean { return this.closed.has(id); }
  reopen(id: string): void { this.cancel(id); this.closed.delete(id); }

  /** final 用于 toolcall_end：立即发布最终摘要，不再等待节流窗口。 */
  update(call: PreparingCall, final = false): void {
    if (this.closed.has(call.id)) return;
    const slot = this.slots.get(call.id);
    const now = this.now();
    if (!slot) {
      this.slots.set(call.id, { latest: call, lastAt: now, timer: null });
      this.publish(call);
      return;
    }
    slot.latest = call;
    const wait = TOOL_PREPARATION_THROTTLE_MS - (now - slot.lastAt);
    if (final || wait <= 0) {
      this.emit(call.id, slot);
      return;
    }
    slot.timer ??= setTimeout(() => this.emit(call.id, slot), wait);
  }

  /** 开始执行：丢弃尚未发出的准备帧，此后忽略该调用的准备更新。 */
  close(id: string): void {
    this.cancel(id);
    this.closed.add(id);
  }

  /** 消息结束：未执行的调用不再有新参数，只停止计时，不阻止随后的执行开始。 */
  settle(): void {
    for (const id of [...this.slots.keys()]) this.cancel(id);
  }

  clear(): void {
    this.settle();
    this.closed.clear();
  }

  private emit(id: string, slot: Slot): void {
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = null;
    slot.lastAt = this.now();
    this.publish(slot.latest);
  }

  private cancel(id: string): void {
    const slot = this.slots.get(id);
    if (slot?.timer != null) clearTimeout(slot.timer);
    this.slots.delete(id);
  }
}
