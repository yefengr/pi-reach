import { anchorFromLocator } from "./timeline-viewport-anchor";
import type { TimelineSessionPosition } from "./use-timeline-viewport";

/** 阅读位置的可序列化形式：跟随最新，或屏幕顶部那一行的标识与它距列表顶边的偏移。 */
export type StoredViewportPosition = { following: true } | { following: false; row: string; block: number | null; rowOffsetTop: number; offsetTop: number };
type StoredEntry = StoredViewportPosition | { history: true; position: StoredViewportPosition; shown: number };

/** 本次访问内存中的位置（带 DOM 引用），或重载后从存储读回的位置。 */
export type SavedSessionPosition = TimelineSessionPosition | StoredViewportPosition;
export type SavedSessionEntry = SavedSessionPosition | { history: true; position: SavedSessionPosition; shown: number };
type MemoryEntry = TimelineSessionPosition | { history: true; position: TimelineSessionPosition; shown: number };

export const SESSION_POSITION_STORAGE_KEY = "pi-reach-session-positions";
export const SESSION_POSITION_MAX_ENTRIES = 50;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function validPosition(value: unknown): value is StoredViewportPosition {
  if (!value || typeof value !== "object") return false;
  const position = value as Record<string, unknown>;
  if (position.following === true) return true;
  return position.following === false && typeof position.row === "string" && position.row !== ""
    && (position.block === null || finite(position.block)) && finite(position.rowOffsetTop) && finite(position.offsetTop);
}

function validEntry(value: unknown): value is StoredEntry {
  if (validPosition(value)) return true;
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return entry.history === true && validPosition(entry.position) && finite(entry.shown) && entry.shown >= 0;
}

/** 没有行标识的锚点重载后无法定位，不保存。 */
export function toStoredPosition(position: TimelineSessionPosition): StoredViewportPosition | null {
  if (position.following) return { following: true };
  const locator = position.anchor.rowLocator;
  if (!locator) return null;
  return { following: false, row: locator.key, block: locator.blockIndex, rowOffsetTop: position.anchor.rowOffsetTop, offsetTop: position.anchor.offsetTop };
}

export function isStoredPosition(position: SavedSessionPosition): position is StoredViewportPosition {
  return position.following || "row" in position;
}

/** 把读回的位置接到当前列表上：没有原 DOM 节点，恢复时按行标识重新定位。 */
export function fromStoredPosition(list: HTMLDivElement, stored: StoredViewportPosition): TimelineSessionPosition {
  if (stored.following) return { following: true };
  return { following: false, anchor: anchorFromLocator(list, { attribute: "data-viewport-row", key: stored.row, blockIndex: stored.block }, stored.rowOffsetTop, stored.offsetTop) };
}

/**
 * 各会话的阅读位置。内存中的位置优先（同一次访问中切回）；另以可序列化形式写入 sessionStorage，
 * 页面被系统回收重载后仍能回到原处，关闭标签页或应用后清除。
 */
export class SessionPositionStore {
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly stored: Map<string, StoredEntry>;
  private cleared = false;

  constructor() {
    this.stored = new Map();
    if (typeof window === "undefined") return;
    try {
      const parsed: unknown = JSON.parse(window.sessionStorage.getItem(SESSION_POSITION_STORAGE_KEY) ?? "[]");
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        if (Array.isArray(item) && typeof item[0] === "string" && validEntry(item[1])) this.stored.set(item[0], item[1]);
      }
    } catch { /* 存储不可用或内容损坏时从空开始 */ }
  }

  get(key: string): SavedSessionEntry | undefined {
    return this.memory.get(key) ?? this.stored.get(key);
  }

  set(key: string, entry: MemoryEntry): void {
    this.memory.set(key, entry);
    const position = toStoredPosition("history" in entry ? entry.position : entry);
    // 重新写入的键移到末尾，超出数量时先淘汰最久未更新的。
    this.stored.delete(key);
    if (position) this.stored.set(key, "history" in entry ? { history: true, position, shown: entry.shown } : position);
    while (this.stored.size > SESSION_POSITION_MAX_ENTRIES) this.stored.delete(this.stored.keys().next().value as string);
    this.persist();
  }

  /** 清除本地数据：之后到页面重载前不再写入。 */
  clear(): void {
    this.cleared = true;
    this.memory.clear();
    this.stored.clear();
    try { window.sessionStorage.removeItem(SESSION_POSITION_STORAGE_KEY); } catch { /* 存储不可用时无内容可清 */ }
  }

  private persist(): void {
    if (this.cleared || typeof window === "undefined") return;
    try { window.sessionStorage.setItem(SESSION_POSITION_STORAGE_KEY, JSON.stringify([...this.stored])); } catch { /* 存储不可用时位置只保留在本次运行内 */ }
  }
}
