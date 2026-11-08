import { MAX_TOOL_DETAILS_BYTES, MAX_TOOL_DETAILS_CACHE_BYTES, MAX_TOOL_DETAILS_CACHE_ENTRIES, toolDetailsContentSchema, type ToolDetailsContent, type ToolRef } from "@pi-reach/protocol/session";
import { getPwaDatabase } from "./db";

export type ToolDetailsCacheScope = { ownerId: string; deviceId: string; endpointId: string; sessionId: string };
export type ToolDetailsCacheRecord = ToolDetailsCacheScope & { id: string; text: string; bytes: number; usedAt: number };
export interface ToolDetailsCache {
  get(key: string): Promise<ToolDetailsContent | undefined>;
  put(scope: ToolDetailsCacheScope, groupId: string, ref: ToolRef, text: string): Promise<void>;
}
export function toolDetailsCacheKey(scope: ToolDetailsCacheScope, groupId: string, ref: ToolRef): string {
  // 正式历史与可回收详情都不把临时 runtime/channel/leaf 当作持久身份。
  return JSON.stringify([scope.ownerId, scope.deviceId, scope.endpointId, scope.sessionId, groupId, ref.call_entry_id, ref.tool_call_id]);
}
export class PersistentToolDetailsCache implements ToolDetailsCache {
  async get(key: string): Promise<ToolDetailsContent | undefined> {
    const db = getPwaDatabase();
    return db.transaction("rw", db.toolDetails, async () => {
      const record = await db.toolDetails.get(key);
      if (!record) return undefined;
      try {
        if (!Number.isSafeInteger(record.bytes) || record.bytes < 0 || record.bytes > MAX_TOOL_DETAILS_BYTES
          || record.text.length > MAX_TOOL_DETAILS_BYTES || new TextEncoder().encode(record.text).length !== record.bytes) throw new Error("budget");
        const value = toolDetailsContentSchema.parse(JSON.parse(record.text));
        if (value.source !== "session" || value.limited) throw new Error("preview");
        await db.toolDetails.update(key, { usedAt: Date.now() });
        return value;
      } catch {
        await db.toolDetails.delete(key);
        return undefined;
      }
    });
  }
  async put(scope: ToolDetailsCacheScope, groupId: string, ref: ToolRef, text: string): Promise<void> {
    if (text.length > MAX_TOOL_DETAILS_BYTES) return;
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > MAX_TOOL_DETAILS_BYTES) return;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return; }
    const value = toolDetailsContentSchema.safeParse(parsed);
    if (!value.success || value.data.source !== "session" || value.data.limited || value.data.tool_ref.call_entry_id !== ref.call_entry_id || value.data.tool_ref.tool_call_id !== ref.tool_call_id) return;
    const db = getPwaDatabase();
    await db.transaction("rw", [db.toolDetails, db.sessions], async () => {
      // 与清会话／清配对共享事务锁；晚到的缓存写入不能重新制造孤立详情。
      const session = await db.sessions.where("deviceId").equals(scope.deviceId)
        .filter(record => record.endpointId === scope.endpointId && record.sessionId === scope.sessionId).first();
      if (!session) return;
      const id = toolDetailsCacheKey(scope, groupId, ref);
      await db.toolDetails.put({ ...scope, id, text, bytes, usedAt: Date.now() });
      const records = await db.toolDetails.orderBy("usedAt").toArray();
      let total = records.reduce((sum, record) => sum + record.bytes, 0);
      let count = records.length;
      const remove: string[] = [];
      for (const record of records) {
        if (total <= MAX_TOOL_DETAILS_CACHE_BYTES && count <= MAX_TOOL_DETAILS_CACHE_ENTRIES) break;
        remove.push(record.id); total -= record.bytes; count -= 1;
      }
      await db.toolDetails.bulkDelete(remove);
    });
  }
}
