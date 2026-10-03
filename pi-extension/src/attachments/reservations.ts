import { randomUUID } from "node:crypto";
import { link, opendir, rename, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ATTACHMENT_MAX_FILE_BYTES } from "@pi-reach/protocol/session";
import { assertDirectories, assertRegularFile, createPrivateFile, ensurePrivateDirectory, readPrivateFile } from "./safe-files.js";
import { AttachmentStoreError, nodeErrorHasCode, type AttachmentStoreTestHooks } from "./types.js";

const RECORD_MAX_BYTES = 4096;
const RECORD_MAX_COUNT = 4096;
const CHECK_ATTEMPTS = 3;
const CHECK_RETRY_MS = 5;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RECORD_NAME = new RegExp(`^${UUID}\\.json$`);
const PENDING_NAME = new RegExp(`^${UUID}\\.pending$`);

interface ReservationRecord {
  pid: number;
  runtimeId: string;
  uploadId: string;
  remainingBytes: number;
}

function roundAllocation(bytes: number, unit: bigint): number {
  const rounded = ((BigInt(bytes) + unit - 1n) / unit) * unit;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new AttachmentStoreError("io_error");
  return Number(rounded);
}

function parseRecord(raw: string, unit: bigint): ReservationRecord {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new AttachmentStoreError("io_error"); }
  if (typeof data !== "object" || data === null) throw new AttachmentStoreError("io_error");
  const item = data as Partial<ReservationRecord>;
  if (Object.keys(item).sort().join(",") !== "pid,remainingBytes,runtimeId,uploadId" ||
      !Number.isSafeInteger(item.pid) || (item.pid ?? 0) <= 0 ||
      typeof item.runtimeId !== "string" || item.runtimeId.length < 1 || item.runtimeId.length > 256 ||
      typeof item.uploadId !== "string" || item.uploadId.length < 1 || item.uploadId.length > 256 ||
      !Number.isSafeInteger(item.remainingBytes) || (item.remainingBytes ?? -1) < 0 ||
      (item.remainingBytes ?? Infinity) > roundAllocation(ATTACHMENT_MAX_FILE_BYTES, unit) ||
      BigInt(item.remainingBytes ?? 0) % unit !== 0n) {
    throw new AttachmentStoreError("io_error");
  }
  return item as ReservationRecord;
}

function provenDead(pid: number): boolean {
  try { process.kill(pid, 0); } catch (error) { return nodeErrorHasCode(error, "ESRCH"); }
  // PID 复用和 EPERM 都保守占预算，不按年龄删除记录或原件。
  return false;
}

export class DiskReservation {
  private readonly directory: string;
  private readonly path: string;
  private readonly record: ReservationRecord;
  private published = false;
  private allocationUnit = 1n;

  constructor(
    private readonly root: string,
    runtimeId: string,
    uploadId: string,
    private readonly byteLength: number,
    private readonly floor: bigint,
    private readonly hooks: AttachmentStoreTestHooks = {},
  ) {
    this.directory = join(root, ".reservations");
    this.path = join(this.directory, `${randomUUID()}.json`);
    this.record = { pid: process.pid, runtimeId, uploadId, remainingBytes: byteLength };
  }

  async publish(): Promise<void> {
    ensurePrivateDirectory(this.directory);
    this.allocationUnit = this.hooks.availableBytes ? BigInt(this.hooks.allocationUnitBytes ?? 1) :
      (await statfs(this.root, { bigint: true })).bsize;
    if (this.allocationUnit <= 0n) throw new AttachmentStoreError("io_error");
    this.record.remainingBytes = roundAllocation(this.record.remainingBytes, this.allocationUnit);
    await this.replace(this.record, true);
    this.published = true;
    try { await this.check(); } catch (error) { await this.remove(); throw error; }
  }

  private async replace(record: ReservationRecord, initial: boolean): Promise<void> {
    assertDirectories(this.directory);
    const pending = join(this.directory, `${randomUUID()}.pending`);
    const handle = await createPrivateFile(pending);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
      await handle.close();
      if (initial) {
        // link 为独占发布；pending 从不计入 credits，也从不准许写原件。
        await link(pending, this.path);
      } else {
        await this.assertOwned();
        await rename(pending, this.path);
      }
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(pending).catch((error: unknown) => {
        if (!nodeErrorHasCode(error, "ENOENT")) throw error;
      });
    }
  }

  private async assertOwned(): Promise<void> {
    if (!this.published) throw new AttachmentStoreError("invalid_upload");
    assertDirectories(this.directory);
    const current = parseRecord(await readPrivateFile(this.path, RECORD_MAX_BYTES), this.allocationUnit);
    if (current.pid !== this.record.pid || current.runtimeId !== this.record.runtimeId ||
        current.uploadId !== this.record.uploadId || current.remainingBytes !== this.record.remainingBytes) {
      throw new AttachmentStoreError("invalid_upload");
    }
  }

  private async totalRemaining(): Promise<bigint> {
    let total = 0n;
    let activeCount = 0;
    // 流式枚举，不把历史死亡账本的总数当作活跃上传配额。
    for await (const entry of await opendir(this.directory)) {
      const name = entry.name;
      const path = join(this.directory, name);
      try {
        assertRegularFile(path);
        if (PENDING_NAME.test(name)) continue;
        if (!RECORD_NAME.test(name)) throw new AttachmentStoreError("io_error");
        const record = parseRecord(await readPrivateFile(path, RECORD_MAX_BYTES), this.allocationUnit);
        if (provenDead(record.pid)) continue;
        if (++activeCount > RECORD_MAX_COUNT) throw new AttachmentStoreError("no_space", true);
        total += BigInt(record.remainingBytes);
      } catch (error) {
        // 删除只发生在该 reservation 已不再可能写入之后。
        if (!nodeErrorHasCode(error, "ENOENT")) throw error;
      }
    }
    return total;
  }

  async check(): Promise<void> {
    for (let attempt = 0; attempt < CHECK_ATTEMPTS; attempt++) {
      await this.assertOwned();
      const remaining = await this.totalRemaining();
      // 必须先扫描 credits，再读取空间。旧 credits 与新空间只会高估需求。
      const available = this.hooks.availableBytes ? await this.hooks.availableBytes() : await this.available();
      if (remaining + this.floor <= available) return;
      if (attempt + 1 < CHECK_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, CHECK_RETRY_MS));
    }
    throw new AttachmentStoreError("no_space", true);
  }

  private async available(): Promise<bigint> {
    const stats = await statfs(this.root, { bigint: true });
    return stats.bavail * stats.bsize;
  }

  async reduce(remainingBytes: number): Promise<void> {
    if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0 || remainingBytes > this.byteLength) {
      throw new AttachmentStoreError("invalid_upload");
    }
    // 已落盘的尾块可承载后续字节，不重复预留同一个分配单元。
    const credits = roundAllocation(this.byteLength, this.allocationUnit) -
      roundAllocation(this.byteLength - remainingBytes, this.allocationUnit);
    if (credits > this.record.remainingBytes) throw new AttachmentStoreError("invalid_upload");
    const next = { ...this.record, remainingBytes: credits };
    await this.replace(next, false);
    this.record.remainingBytes = credits;
  }

  async remove(): Promise<void> {
    if (!this.published) return;
    await this.assertOwned();
    await unlink(this.path);
    this.published = false;
  }
}
