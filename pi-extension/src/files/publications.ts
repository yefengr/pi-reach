import { readFileSync, statSync, type BigIntStats } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseSessionEntries, type FileEntry, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import { idSchema, PUBLISHED_FILE_TYPE, publishedFileMetadataSchema, type PublishedFileMetadata } from "@pi-reach/protocol/session";
import { z } from "zod";

export const PUBLISHED_FILE_TOOL_NAME = "publish_file" as const;

export type ConfirmedPublication = {
  id: string;
  sourcePath: string;
  metadata: PublishedFileMetadata;
  groupId?: string;
  timestamp: number;
  branchPosition: number;
};

/** 只存于原生 custom；不能把此 schema 当作 wire payload。 */
export const publicationDataSchema = publishedFileMetadataSchema.extend({
  source_path: z.string().min(1).refine((path) => !path.includes("\0") && isAbsolute(path) && resolve(path) === path),
  group_id: idSchema.optional(),
}).strict();
const resultDetailsSchema = z.object({ publication_id: idSchema }).strict();
type DiskProof = { path: string; stat: BigIntStats; entries: FileEntry[] };
// 一个 manager 最多保留一个文件的解析结果；manager 回收时缓存随之回收。
const diskProofs = new WeakMap<SessionManager, DiskProof>();

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function diskEntries(manager: SessionManager): FileEntry[] | null {
  try {
    const path = manager.getSessionFile();
    if (!path) return null;
    const before = statSync(path, { bigint: true });
    if (!before.isFile()) return null;
    const cached = diskProofs.get(manager);
    if (cached?.path === path && sameFile(cached.stat, before)) return cached.entries;
    const entries = parseSessionEntries(readFileSync(path, "utf8"));
    const after = statSync(path, { bigint: true });
    if (!after.isFile() || !sameFile(before, after)) return null;
    diskProofs.set(manager, { path, stat: after, entries });
    return entries;
  } catch {
    diskProofs.delete(manager);
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSONL 不存 undefined 字段；比较完整原生记录而非只比较 publication_id。 */
function samePersistedEntry(current: unknown, persisted: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(current)), persisted);
}

function addByCall<T>(map: Map<string, T[]>, callId: unknown, value: T): void {
  if (typeof callId !== "string") return;
  const matches = map.get(callId) ?? [];
  matches.push(value);
  map.set(callId, matches);
}

/**
 * 原生成功 toolResult 是确认点，且 custom/result 两者均须已落盘。
 * 失败 append 留下的内部孤立记录无资格；不尝试回滚 SDK 的 append-only 树。
 */
export function collectPublications(manager: SessionManager): Map<string, ConfirmedPublication> {
  const confirmed = new Map<string, ConfirmedPublication>();
  try {
    const persisted = diskEntries(manager);
    if (!persisted) return confirmed;
    const headers = persisted.filter((entry) => record(entry) && entry.type === "session");
    const header = manager.getHeader();
    if (headers.length !== 1 || persisted[0] !== headers[0] || !header
      || header.id !== manager.getSessionId() || !samePersistedEntry(header, headers[0])) return confirmed;

    const diskById = new Map<string, FileEntry>();
    for (const entry of persisted) {
      if (!record(entry) || !idSchema.safeParse(entry.id).success || diskById.has(entry.id)) return confirmed;
      diskById.set(entry.id, entry);
    }
    const branch = manager.getBranch();
    const customs = new Map<string, Array<{ entry: Extract<SessionEntry, { type: "custom" }>; index: number }>>();
    const results = new Map<string, Array<{ entry: Extract<SessionEntry, { type: "message" }>; index: number }>>();
    const branchIds = new Set<string>();
    const persistedPrefixes: boolean[] = [];
    let persistedPrefix = true;
    for (let index = 0; index < branch.length; index++) {
      const entry = branch[index]!;
      if (branchIds.has(entry.id) || entry.parentId !== (index === 0 ? null : branch[index - 1]!.id)) return confirmed;
      branchIds.add(entry.id);
      const diskEntry = diskById.get(entry.id);
      persistedPrefix = persistedPrefix && diskEntry?.type === entry.type
        && "parentId" in diskEntry && diskEntry.parentId === entry.parentId;
      persistedPrefixes.push(persistedPrefix);
      if (entry.type === "custom" && entry.customType === PUBLISHED_FILE_TYPE) {
        addByCall(customs, record(entry.data) ? entry.data.tool_call_id : undefined, { entry, index });
      } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === PUBLISHED_FILE_TOOL_NAME) {
        addByCall(results, entry.message.toolCallId, { entry, index });
      }
    }

    const candidates: ConfirmedPublication[] = [];
    for (const [callId, matches] of customs) {
      const tools = results.get(callId);
      if (matches.length !== 1 || tools?.length !== 1) continue;
      const custom = matches[0]!;
      const result = tools[0]!;
      const data = publicationDataSchema.safeParse(custom.entry.data);
      const message = result.entry.message;
      if (!data.success || message.role !== "toolResult" || message.isError !== false
        || result.index <= custom.index || !persistedPrefixes[result.index]) continue;
      const details = resultDetailsSchema.safeParse(message.details);
      const timestamp = Date.parse(custom.entry.timestamp);
      if (!details.success || details.data.publication_id !== custom.entry.id || !Number.isFinite(timestamp) || timestamp < 0) continue;
      if (!samePersistedEntry(custom.entry, diskById.get(custom.entry.id))
        || !samePersistedEntry(result.entry, diskById.get(result.entry.id))) continue;
      const { source_path, group_id, ...metadata } = data.data;
      candidates.push({
        id: custom.entry.id, sourcePath: source_path, metadata, timestamp,
        ...(group_id === undefined ? {} : { groupId: group_id }),
        branchPosition: result.index + 0.5,
      });
    }
    candidates.sort((left, right) => left.branchPosition - right.branchPosition);
    for (const candidate of candidates) confirmed.set(candidate.id, candidate);
    return confirmed;
  } catch {
    // 不可信或无法读取的原生记录只能拒绝资格，不能降级为内存证明。
    return new Map();
  }
}
