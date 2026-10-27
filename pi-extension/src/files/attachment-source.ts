import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AttachmentDescriptor } from "@pi-reach/protocol/session";
import { defaultAttachmentRoot, safeAttachmentFileName } from "../attachments/storage-path.js";
import { attachmentRecords } from "../timeline/attachment_content.js";

export type AttachmentSource = { sourcePath: string; fileName: string; byteLength: number; sha256: string };

const DATE_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/;
// 附件 ID 由服务端 randomUUID 生成；分支记录可被本地改写，仍拒绝能充当路径组件的值。
const SAFE_ID = /^[A-Za-z0-9-]+$/;
const MAX_CACHED_PATHS = 64;

/** 只承认当前分支上已绑定正式消息的附件；客户端提供的 ID 只用于查找。 */
export function branchAttachment(manager: SessionManager, attachmentId: string): AttachmentDescriptor | null {
  for (const metadata of attachmentRecords(manager).values()) {
    const found = metadata.attachments.find((item) => item.attachment_id === attachmentId);
    if (found) return found;
  }
  return null;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch { return false; }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

/**
 * 原件路径不持久化，按写入规则推导：`<root>/<YYYY-MM-DD>/<id>/<安全文件名>`；
 * 早期版本为 `<root>/<sha256(sessionId)>/<id>.bin`。打开、身份与摘要校验由读取器负责。
 */
export class AttachmentSourceResolver {
  private readonly paths = new Map<string, string>();

  constructor(private readonly root: string = defaultAttachmentRoot()) {}

  async resolve(manager: SessionManager, attachmentId: string): Promise<AttachmentSource | null> {
    if (!SAFE_ID.test(attachmentId)) return null;
    const descriptor = branchAttachment(manager, attachmentId);
    if (!descriptor) return null;
    const sourcePath = this.cached(attachmentId) ?? await this.locate(manager.getSessionId(), descriptor);
    if (!sourcePath) return null;
    this.remember(attachmentId, sourcePath);
    return { sourcePath, fileName: descriptor.file_name, byteLength: descriptor.byte_length, sha256: descriptor.sha256 };
  }

  private cached(attachmentId: string): string | undefined {
    const path = this.paths.get(attachmentId);
    if (path === undefined) return undefined;
    this.paths.delete(attachmentId);
    this.paths.set(attachmentId, path);
    return path;
  }

  private remember(attachmentId: string, path: string): void {
    this.paths.delete(attachmentId);
    this.paths.set(attachmentId, path);
    if (this.paths.size > MAX_CACHED_PATHS) this.paths.delete(this.paths.keys().next().value!);
  }

  private async locate(sessionId: string, descriptor: AttachmentDescriptor): Promise<string | null> {
    let root: string;
    let entries: string[];
    try {
      // 读取器要求规范路径；home 下存在链接时也要与 realpath 一致。
      root = await realpath(this.root);
      entries = await readdir(root);
    } catch { return null; }
    const id = descriptor.attachment_id;
    // 新附件多在近期目录，倒序查找可尽早命中。
    for (const date of entries.filter((name) => DATE_DIRECTORY.test(name)).sort().reverse()) {
      const directory = join(root, date, id);
      if (await isDirectory(directory)) return join(directory, safeAttachmentFileName(descriptor.file_name));
    }
    const legacy = join(root, createHash("sha256").update(sessionId).digest("hex"), `${id}.bin`);
    return await exists(legacy) ? legacy : null;
  }
}
