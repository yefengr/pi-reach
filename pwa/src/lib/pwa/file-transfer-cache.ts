import type { FileTransferResult } from "./file-transfer-types";

export const FILE_CACHE_BYTES = 64 * 1024 * 1024;
/** 空原件也占用 URL/元数据；字节预算之外限制条目数量。 */
const FILE_CACHE_ENTRIES = 64;
type Cached = { result: FileTransferResult; bytes: number };

/** 原件字节预算包含活任务预留；pin 只禁止逐出，不豁免预算。 */
export class FileTransferCache {
  private readonly entries = new Map<string, Cached>();
  private readonly pins = new Map<string, number>();
  private used = 0;
  private reserved = 0;

  constructor(private readonly budget: number, private readonly revoke: (url: string) => void,
    private readonly evict: (id: string) => void) {}

  pin(id: string): void { this.pins.set(id, (this.pins.get(id) ?? 0) + 1); }
  unpin(id: string): void {
    const count = this.pins.get(id) ?? 0;
    if (count <= 1) this.pins.delete(id); else this.pins.set(id, count - 1);
  }
  touch(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.entries.set(id, entry);
  }
  reserve(bytes: number): boolean {
    if (bytes > this.budget) return false;
    const candidates = [...this.entries].filter(([id]) => !this.pins.has(id));
    if (this.used + bytes - candidates.reduce((sum, [, entry]) => sum + entry.bytes, 0) > this.budget
      || this.entries.size - candidates.length >= FILE_CACHE_ENTRIES) return false;
    for (const [id, entry] of candidates) {
      if (this.used + bytes <= this.budget && this.entries.size < FILE_CACHE_ENTRIES) break;
      this.entries.delete(id);
      this.used -= entry.bytes;
      this.revoke(entry.result.url);
      this.evict(id);
    }
    this.reserved = bytes;
    return true;
  }
  drop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.used -= entry.bytes;
    this.revoke(entry.result.url);
    this.evict(id);
  }
  release(): void { this.reserved = 0; }
  commit(id: string, result: FileTransferResult): void {
    this.entries.set(id, { result, bytes: this.reserved });
    this.used += this.reserved;
    this.reserved = 0;
  }
  reset(): void {
    for (const entry of this.entries.values()) this.revoke(entry.result.url);
    this.entries.clear();
    this.pins.clear();
    this.used = 0;
    this.reserved = 0;
  }
}
