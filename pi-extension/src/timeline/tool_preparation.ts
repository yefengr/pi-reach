import type { JsonValue } from "../protocol/v2/index.js";
import { jsonValue } from "./tool_lifecycle.js";

/** 参数生成期间的发布间隔：首帧立即发布，之后每个调用最多每 100ms 一帧，避免逐 token 刷帧。 */
export const TOOL_PREPARATION_THROTTLE_MS = 100;
/**
 * 准备中参数里单个字符串的上限：准备阶段只用于显示工具名与命令／路径摘要，
 * 写入大文件时不随每帧重复发送整段内容；完整参数在开始执行时由运行帧送达。
 */
export const TOOL_PREPARATION_STRING_CHARS = 2048;
const PREPARATION_TRUNCATED = "…";

function previewJson(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    if (value.length <= TOOL_PREPARATION_STRING_CHARS) return value;
    let end = TOOL_PREPARATION_STRING_CHARS;
    const last = value.charCodeAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
    return value.slice(0, end) + PREPARATION_TRUNCATED;
  }
  if (Array.isArray(value)) return value.map(previewJson);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, { value: previewJson(item), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

export type PreparingCall = Readonly<{ id: string; tool: string; args: JsonValue }>;

type Slot = { latest: PreparingCall; lastAt: number; timer: ReturnType<typeof setTimeout> | null };

/** 从 SDK 的 toolCall 内容块取出可发布的调用；ID 或名称尚未到达时返回 null，等后续增量补齐。 */
export function preparingCall(block: unknown): PreparingCall | null {
  if (!block || typeof block !== "object") return null;
  const call = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
  if (call.type !== "toolCall" || typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !call.name) return null;
  return { id: call.id, tool: call.name, args: previewJson(jsonValue(call.arguments ?? {})) };
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

  /** final 用于 toolcall_end：立即发布完整参数，不再等待节流窗口。 */
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
