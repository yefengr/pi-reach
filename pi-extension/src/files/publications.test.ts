import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, parseSessionEntries, type CustomEntry, type FileEntry } from "@earendil-works/pi-coding-agent";
import { PUBLISHED_FILE_TYPE } from "@pi-reach/protocol/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectPublications, PUBLISHED_FILE_TOOL_NAME } from "./publications.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

type Message = Parameters<SessionManager["appendMessage"]>[0];
let directory: string;
let manager: SessionManager;
const metadata = { file_name: "报告.txt", mime_type: "text/plain", byte_length: 12, tool_call_id: "call-1" };

function assistant(target: SessionManager): string {
  return target.appendMessage({
    role: "assistant", content: [{ type: "text", text: "ready" }],
    api: "openai-completions", provider: "test", model: "test", stopReason: "stop", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as Message);
}
function custom(target = manager, data: unknown = { source_path: "/outside/report.txt", ...metadata, group_id: "group-1" }): string {
  return target.appendCustomEntry(PUBLISHED_FILE_TYPE, data);
}
function result(id: string, options: { target?: SessionManager; callId?: string; name?: string; error?: boolean; details?: unknown } = {}): string {
  return (options.target ?? manager).appendMessage({
    role: "toolResult", toolName: options.name ?? PUBLISHED_FILE_TOOL_NAME, toolCallId: options.callId ?? "call-1",
    isError: options.error ?? false, details: options.details ?? { publication_id: id },
    content: [{ type: "text", text: "文件已发布" }], timestamp: 2,
  } as Message);
}
function rewrite(transform: (entries: FileEntry[]) => FileEntry[]): void {
  const file = manager.getSessionFile()!;
  writeFileSync(file, transform(parseSessionEntries(readFileSync(file, "utf8"))).map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-reach-publications-"));
  manager = SessionManager.create(directory, join(directory, "sessions"));
  assistant(manager); // SDK 首次 assistant 才 flush 会话。
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("collectPublications", () => {
  it("requires both native records and recovers the same metadata after real disk reopen", () => {
    const id = custom();
    expect(collectPublications(manager).size).toBe(0);
    const resultId = result(id);
    const branch = manager.getBranch();
    const publication = collectPublications(manager).get(id);
    expect(publication).toEqual({ id, sourcePath: "/outside/report.txt", metadata, groupId: "group-1",
      timestamp: Date.parse(manager.getEntry(id)!.timestamp), branchPosition: branch.findIndex((entry) => entry.id === resultId) + 0.5 });
    const reopened = SessionManager.open(manager.getSessionFile()!, join(directory, "sessions"));
    expect(collectPublications(reopened).get(id)).toEqual(publication);
  });

  it("keeps parent publications on either sibling and through compaction, excludes sibling-only files", () => {
    const parent = custom();
    const parentResult = result(parent);
    const sibling = custom(manager, { source_path: "/sibling.txt", ...metadata, tool_call_id: "call-2" });
    result(sibling, { callId: "call-2" });
    expect([...collectPublications(manager).keys()]).toEqual([parent, sibling]);
    manager.branch(parentResult);
    const newLeaf = manager.appendMessage({ role: "user", content: "sibling", timestamp: 3 });
    expect([...collectPublications(manager).keys()]).toEqual([parent]);
    manager.appendCompaction("compacted", newLeaf, 100);
    expect(manager.buildContextEntries().some((entry) => entry.id === parent)).toBe(false);
    expect([...collectPublications(manager).keys()]).toEqual([parent]);
    manager.branch(parent);
    expect(collectPublications(manager).size).toBe(0); // 尚无当前分支 result。
  });

  it("orders at confirmation positions rather than custom positions", () => {
    const first = custom();
    const second = custom(manager, { source_path: "/second.txt", ...metadata, tool_call_id: "call-2" });
    const secondResult = result(second, { callId: "call-2" });
    const firstResult = result(first);
    const confirmed = collectPublications(manager);
    expect([...confirmed.keys()]).toEqual([second, first]);
    const branch = manager.getBranch();
    expect(confirmed.get(second)!.branchPosition).toBe(branch.findIndex((entry) => entry.id === secondResult) + 0.5);
    expect(confirmed.get(first)!.branchPosition).toBe(branch.findIndex((entry) => entry.id === firstResult) + 0.5);
  });

  it.each([
    { error: true }, { callId: "unmatched" }, { name: "other_tool" },
    { details: { publication_id: "other-id" } }, { details: {} },
    { details: { publication_id: "placeholder", source_path: "/leak" } },
  ])("rejects failed, unmatched, wrong-tool and nonstrict results: %j", (options) => {
    const id = custom();
    result(id, options);
    expect(collectPublications(manager).size).toBe(0);
  });

  it("does not accept a matching result that predates its custom", () => {
    const id = custom();
    result(id);
    const branch = manager.getBranch();
    const before = [branch[0]!, branch[2]!, branch[1]!].map((entry, index, entries) => ({
      ...entry, parentId: index === 0 ? null : entries[index - 1]!.id,
    }));
    vi.spyOn(manager, "getBranch").mockReturnValue(before);
    expect(collectPublications(manager).size).toBe(0);
  });

  it.each([
    { source_path: "relative.txt" }, { source_path: "/outside/../report.txt" }, { source_path: "/bad\0file" },
    { extra: true }, { group_id: "" }, { byte_length: 50 * 1024 * 1024 + 1 },
    { file_name: "bad\nname" }, { mime_type: "invalid" }, { tool_call_id: "" },
  ])("strictly rejects invalid custom data: %j", (overrides) => {
    const id = custom(manager, { source_path: "/outside/report.txt", ...metadata, ...overrides });
    result(id);
    expect(collectPublications(manager).size).toBe(0);
  });

  it("rejects memory-only, unflushed, absent and unreadable files without relying on isPersisted", () => {
    const memory = SessionManager.inMemory(directory);
    result(custom(memory), { target: memory });
    expect(collectPublications(memory).size).toBe(0);
    const fresh = SessionManager.create(directory, join(directory, "unflushed"));
    result(custom(fresh), { target: fresh });
    expect(collectPublications(fresh).size).toBe(0);
    const id = custom();
    result(id);
    expect(collectPublications(manager).has(id)).toBe(true);
    unlinkSync(manager.getSessionFile()!);
    expect(collectPublications(manager).size).toBe(0);
    // getSessionFile 返回目录时也不能当作有效文件（不依赖 POSIX root 的权限语义）。
    vi.spyOn(manager, "getSessionFile").mockReturnValue(directory);
    expect(collectPublications(manager).size).toBe(0);
  });

  it.each(["before-write", "after-write"])("rejects an orphan after custom persist throws %s", (mode) => {
    const persist = manager._persist.bind(manager);
    vi.spyOn(manager, "_persist").mockImplementationOnce((entry) => {
      if (mode === "after-write") persist(entry);
      throw new Error("disk failure");
    });
    expect(() => custom()).toThrow("disk failure");
    expect(manager.getLeafEntry()!.type).toBe("custom");
    expect(collectPublications(manager).size).toBe(0);
  });

  it("rejects a successful result that mutated memory before failed persistence", () => {
    const id = custom();
    vi.spyOn(manager, "_persist").mockImplementationOnce(() => { throw new Error("disk failure"); });
    expect(() => result(id)).toThrow("disk failure");
    expect(manager.getLeafEntry()!.type).toBe("message");
    expect(manager.isPersisted()).toBe(true);
    expect(collectPublications(manager).size).toBe(0);
  });

  it("accepts proof if a complete successful native result is on disk despite a post-write throw", () => {
    const id = custom();
    const persist = manager._persist.bind(manager);
    vi.spyOn(manager, "_persist").mockImplementationOnce((entry) => { persist(entry); throw new Error("after-write"); });
    expect(() => result(id)).toThrow("after-write");
    // collect 检验的是真实原生记录；工具失败路径自身只会生成 isError:true。
    expect(collectPublications(manager).has(id)).toBe(true);
  });

  it.each(["custom-metadata", "result-details", "result-content", "header", "parent"])("invalidates disk proof when %s changes", (mode) => {
    const id = custom();
    const resultId = result(id);
    expect(collectPublications(manager).has(id)).toBe(true); // 填充缓存。
    rewrite((entries) => entries.map((entry) => {
      if (mode === "header" && entry.type === "session") return { ...entry, id: "other-session" };
      if (entry.id === id && entry.type === "custom" && mode === "custom-metadata") {
        return { ...entry, data: { ...(entry.data as object), byte_length: 11 } };
      }
      if (entry.id === id && mode === "parent") return { ...entry, parentId: "wrong-parent" } as FileEntry;
      if (entry.id === resultId && entry.type === "message" && entry.message.role === "toolResult") {
        if (mode === "result-details") return { ...entry, message: { ...entry.message, details: { publication_id: "wrong" } } };
        if (mode === "result-content") return { ...entry, message: { ...entry.message, content: [{ type: "text", text: "changed" }] } };
      }
      return entry;
    }));
    expect(collectPublications(manager).size).toBe(0);
  });

  it("fails closed on read errors and reuses only unchanged parsed-file proofs", () => {
    const id = custom();
    result(id);
    const read = vi.mocked(readFileSync);
    read.mockClear();
    read.mockImplementationOnce(() => { throw new Error("read failed"); });
    expect(collectPublications(manager).size).toBe(0);
    expect(collectPublications(manager).has(id)).toBe(true);
    const count = read.mock.calls.length;
    expect(collectPublications(manager).has(id)).toBe(true);
    expect(read.mock.calls.length).toBe(count);
  });

  it("rejects orphaned disk ancestry but does not revoke a confirmed prefix for an unpersisted tail", () => {
    const id = custom();
    result(id);
    vi.spyOn(manager, "_persist").mockImplementationOnce(() => { throw new Error("disk failure"); });
    expect(() => manager.appendMessage({ role: "user", content: "tail", timestamp: 3 })).toThrow("disk failure");
    expect(collectPublications(manager).has(id)).toBe(true);
    const rootId = manager.getBranch()[0]!.id;
    rewrite((entries) => entries.filter((entry) => entry.id !== rootId));
    expect(collectPublications(manager).size).toBe(0);
  });

  it("rejects memory metadata diverging from disk", () => {
    const id = custom();
    result(id);
    expect(collectPublications(manager).has(id)).toBe(true);
    (manager.getEntry(id) as CustomEntry<Record<string, unknown>>).data!.source_path = "/changed.txt";
    expect(collectPublications(manager).size).toBe(0);
  });

  it("rejects duplicate native entry IDs on disk", () => {
    const id = custom();
    result(id);
    appendFileSync(manager.getSessionFile()!, JSON.stringify(manager.getEntry(id)) + "\n");
    expect(collectPublications(manager).size).toBe(0);
  });

  it.each(["custom", "result", "failed-result"])("rejects a colliding %s for the same call", (collision) => {
    const id = custom();
    result(id);
    if (collision === "custom") custom();
    else result(id, { error: collision === "failed-result" });
    expect(collectPublications(manager).size).toBe(0);
  });
});
