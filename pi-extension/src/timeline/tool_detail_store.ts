import { MAX_TOOL_PREVIEW_BYTES, MAX_TOOL_PREVIEWS, MAX_TOOL_PREVIEWS_BYTES, MAX_TOOL_DETAIL_SUBSCRIPTIONS,
  boundedJsonByteLength, type ToolDetailsContent, type JsonValue } from "@pi-reach/protocol/session";
import { PUBLISHED_FILE_TOOL_NAME } from "../files/publications.js";

export const TOOL_DETAIL_UPDATE_INTERVAL_MS = 100;

/** 预览只复制有界前缀；不读取图片 data，不遍历超出节点/字符预算的后缀。 */
function previewValue(value: unknown, budget: { chars: number; nodes: number }, depth = 0): JsonValue {
  if (--budget.nodes < 0 || depth > 16 || budget.chars <= 0) return "[preview limited]";
  if (typeof value === "string") {
    let size = Math.min(value.length, budget.chars, 4096);
    const lastCodeUnit = value.charCodeAt(size - 1);
    // 截断时不留下半个代理对；原生保存内容不作改动。
    if (size < value.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) size -= 1;
    budget.chars -= size;
    return value.slice(0, size);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") return null;
  if ((value as { type?: unknown }).type === "image") return { type: "image", omitted: true };
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      if (budget.nodes <= 0 || budget.chars <= 0 || result.length >= 128) break;
      result.push(previewValue(item, budget, depth + 1));
    }
    return result;
  }
  const result: Record<string, JsonValue> = {};
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (budget.nodes <= 0 || budget.chars <= 0) break;
    if (key.length > 256) { budget.nodes -= 1; continue; }
    budget.chars -= key.length;
    Object.defineProperty(result, key, { value: previewValue((value as Record<string, unknown>)[key], budget, depth + 1), enumerable: true });
  }
  return result;
}

export function previewContent(base: Pick<ToolDetailsContent, "tool_ref" | "tool" | "status">, args: unknown, result?: unknown): ToolDetailsContent {
  const budget = { chars: 8000, nodes: 512 };
  const content: ToolDetailsContent = { ...base, source: "preview", limited: true,
    args: base.tool === PUBLISHED_FILE_TOOL_NAME ? {} : previewValue(args, budget),
    ...(result === undefined ? {} : { result: previewValue(result, budget) }) };
  if (boundedJsonByteLength(content, MAX_TOOL_PREVIEW_BYTES) !== null) return content;
  return { ...base, source: "preview", limited: true, args: "[preview unavailable]" };
}

export class ToolDetailStore {
  private readonly previews = new Map<string, Buffer>();
  private readonly watchers = new Map<string, Set<() => void>>();
  private readonly subscriptions = new Set<object>();
  private readonly notificationTimes = new Map<string, number>();
  private readonly notificationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private bytes = 0;
  get stats(): { count: number; bytes: number; subscriptions: number } {
    return { count: this.previews.size, bytes: this.bytes, subscriptions: this.subscriptions.size };
  }
  acquire(token: object): boolean {
    if (this.subscriptions.size >= MAX_TOOL_DETAIL_SUBSCRIPTIONS) return false;
    this.subscriptions.add(token);
    return true;
  }
  release(token: object): void { this.subscriptions.delete(token); }
  watch(key: string, listener: () => void): () => void {
    const watchers = this.watchers.get(key) ?? new Set();
    watchers.add(listener);
    this.watchers.set(key, watchers);
    return () => {
      watchers.delete(listener);
      if (watchers.size) return;
      this.watchers.delete(key);
      this.cancelNotification(key);
    };
  }
  get(key: string): ToolDetailsContent | undefined {
    const data = this.previews.get(key);
    return data ? JSON.parse(data.toString("utf8")) as ToolDetailsContent : undefined;
  }
  put(key: string, content: ToolDetailsContent): void {
    if (boundedJsonByteLength(content, MAX_TOOL_PREVIEW_BYTES) === null) { this.remove(key); return; }
    const data = Buffer.from(JSON.stringify(content));
    this.remove(key, false);
    while (this.previews.size >= MAX_TOOL_PREVIEWS || this.bytes + data.length > MAX_TOOL_PREVIEWS_BYTES) {
      const keys = [...this.previews.keys()];
      const victim = keys.find((id) => !this.watchers.has(id)) ?? keys[0];
      if (!victim) break;
      this.remove(victim);
    }
    this.previews.set(key, data);
    this.bytes += data.length;
    this.notify(key);
  }
  remove(key: string, notify = true): void {
    const previous = this.previews.get(key);
    if (previous) { this.bytes -= previous.length; this.previews.delete(key); }
    // 回收、终态和作用域清理立即通知；不能让旧的延迟预览覆盖正式结果。
    if (notify) this.notify(key, true);
  }
  clearPrefix(prefix: string): void {
    const keys = new Set([...this.previews.keys(), ...this.watchers.keys()]);
    for (const key of keys) if (key.startsWith(prefix)) this.remove(key);
  }
  notify(key: string, immediate = false): void {
    if (!this.watchers.has(key)) return;
    const elapsed = Date.now() - (this.notificationTimes.get(key) ?? Number.NEGATIVE_INFINITY);
    if (immediate || elapsed >= TOOL_DETAIL_UPDATE_INTERVAL_MS) {
      this.cancelNotification(key);
      this.notificationTimes.set(key, Date.now());
      for (const listener of [...this.watchers.get(key) ?? []]) listener();
      return;
    }
    if (this.notificationTimers.has(key)) return;
    // 快速输出只保留缓存中的最新快照，避免为每个 stdout chunk 向所有观看页排队。
    const timer = setTimeout(() => {
      this.notificationTimers.delete(key);
      this.notify(key, true);
    }, TOOL_DETAIL_UPDATE_INTERVAL_MS - elapsed);
    timer.unref?.();
    this.notificationTimers.set(key, timer);
  }
  private cancelNotification(key: string): void {
    const timer = this.notificationTimers.get(key);
    if (timer) clearTimeout(timer);
    this.notificationTimers.delete(key);
    this.notificationTimes.delete(key);
  }
}

/** 所有 Owner/service/runtime 共用同一资源账目。 */
export const toolDetailStore = new ToolDetailStore();
