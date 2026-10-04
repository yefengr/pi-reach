import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PUBLISHED_FILE_TYPE } from "@pi-reach/protocol/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectPublications } from "./publications.js";
import { createPublishFileTool, type PublishFileToolOptions } from "./publish-tool.js";

let directory: string;
let manager: SessionManager;
let currentManager: SessionManager | null;
let current: boolean;
let generation: number;
let groupId: string | null;
let context: ExtensionContext;
let options: PublishFileToolOptions;
const inspected = { sourcePath: "/external/report.txt", fileName: "报告.txt", mimeType: "text/plain", byteLength: 10 };

function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-reach-publish-tool-"));
  manager = SessionManager.create(directory, join(directory, "sessions"));
  manager.appendMessage({
    role: "assistant", content: [], api: "openai-completions", provider: "test", model: "test", stopReason: "stop", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  currentManager = manager;
  current = true;
  generation = 1;
  groupId = "group-1";
  context = { cwd: directory, sessionManager: manager, signal: undefined } as unknown as ExtensionContext;
  options = {
    getManager: () => currentManager,
    isCurrent: () => current,
    getGeneration: () => generation,
    getGroupId: () => groupId,
    inspect: vi.fn(async () => inspected),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("publish_file", () => {
  it("is sequential, resolves against ctx.cwd and returns only an ID and short text", async () => {
    const tool = createPublishFileTool(options);
    const onUpdate = vi.fn();
    const before = manager.getBranch().length;
    const result = await tool.execute("call-1", { path: "report.txt" }, undefined, onUpdate, context);
    expect(tool.name).toBe("publish_file");
    expect(tool.executionMode).toBe("sequential");
    expect(options.inspect).toHaveBeenCalledExactlyOnceWith(resolve(directory, "report.txt"));
    expect(result).toEqual({ content: [{ type: "text", text: "已发布文件引用：报告.txt · text/plain · 10 B" }], details: { publication_id: expect.any(String) } });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(inspected.sourcePath);
    expect(manager.getBranch().length).toBe(before + 1);
    expect(manager.getLeafEntry()).toMatchObject({ type: "custom", customType: PUBLISHED_FILE_TYPE,
      data: { source_path: inspected.sourcePath, file_name: inspected.fileName, mime_type: inspected.mimeType,
        byte_length: inspected.byteLength, tool_call_id: "call-1", group_id: "group-1" } });
    expect(collectPublications(manager).size).toBe(0);
    manager.appendMessage({ role: "toolResult", toolName: tool.name, toolCallId: "call-1", isError: false,
      content: result.content, details: result.details, timestamp: 2 });
    expect(collectPublications(manager).get(result.details.publication_id)?.sourcePath).toBe(inspected.sourcePath);
  });

  it.each(["memory", "unflushed"])("rejects %s sessions before inspection instead of returning unusable success", async (kind) => {
    manager = kind === "memory" ? SessionManager.inMemory(directory) : SessionManager.create(directory, join(directory, "unflushed"));
    currentManager = manager;
    context = { ...context, sessionManager: manager };
    const before = manager.getBranch().length;
    await expect(createPublishFileTool(options).execute("call-1", { path: "report.txt" }, undefined, undefined, context)).rejects.toThrow(/^文件发布失败$/);
    expect(options.inspect).not.toHaveBeenCalled();
    expect(manager.getBranch().length).toBe(before);
  });

  it("allows project-external absolute paths and omits absent group IDs", async () => {
    groupId = null;
    await createPublishFileTool(options).execute("call-1", { path: "/outside/report.txt" }, undefined, undefined, context);
    expect(options.inspect).toHaveBeenCalledExactlyOnceWith("/outside/report.txt");
    expect((manager.getLeafEntry() as { data: object }).data).not.toHaveProperty("group_id");
  });

  it.each(["owner", "manager", "context-manager", "cancel", "context-cancel"])("rejects invalid %s before inspection", async (mode) => {
    const abort = new AbortController();
    if (mode === "owner") current = false;
    if (mode === "manager") currentManager = null;
    if (mode === "context-manager") context = { ...context, sessionManager: SessionManager.inMemory(directory) };
    if (mode === "cancel") abort.abort();
    if (mode === "context-cancel") { abort.abort(); context = { ...context, signal: abort.signal }; }
    const before = manager.getBranch().length;
    await expect(createPublishFileTool(options).execute("call-1", { path: "report.txt" }, mode === "cancel" ? abort.signal : undefined,
      undefined, context)).rejects.toThrow(/^文件发布失败$/);
    expect(options.inspect).not.toHaveBeenCalled();
    expect(manager.getBranch().length).toBe(before);
  });

  it.each(["owner", "manager", "context-manager", "generation", "session", "cancel", "context-cancel", "stale-context"])(
    "rejects %s invalidation while inspecting before appending", async (mode) => {
      const pending = gate<typeof inspected>();
      const abort = new AbortController();
      options.inspect = vi.fn(() => pending.promise);
      const tool = createPublishFileTool(options);
      const promise = tool.execute("call-1", { path: "report.txt" }, abort.signal, undefined, context);
      const rejected = expect(promise).rejects.toThrow(/^文件发布失败$/);
      if (mode === "owner") current = false;
      if (mode === "manager") currentManager = SessionManager.inMemory(directory);
      if (mode === "context-manager") Object.assign(context, { sessionManager: SessionManager.inMemory(directory) });
      if (mode === "generation") generation++;
      if (mode === "session") manager.newSession();
      if (mode === "cancel") abort.abort();
      if (mode === "context-cancel") { const ctxAbort = new AbortController(); ctxAbort.abort(); Object.assign(context, { signal: ctxAbort.signal }); }
      if (mode === "stale-context") Object.defineProperty(context, "sessionManager", { get: () => { throw new Error("stale with /private/path"); } });
      pending.release(inspected);
      await rejected;
      expect(manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === PUBLISHED_FILE_TYPE)).toBe(false);
    },
  );

  it("captures group at execution start, not a later async context", async () => {
    const pending = gate<typeof inspected>();
    options.inspect = () => pending.promise;
    const promise = createPublishFileTool(options).execute("call-1", { path: "report.txt" }, undefined, undefined, context);
    groupId = "other-group";
    pending.release(inspected);
    await promise;
    expect(manager.getLeafEntry()).toMatchObject({ data: { group_id: "group-1" } });
  });

  it("rejects old tool instances after owner replacement", async () => {
    const old = createPublishFileTool(options);
    current = false;
    await expect(old.execute("call-1", { path: "report.txt" }, undefined, undefined, context)).rejects.toThrow(/^文件发布失败$/);
    expect(options.inspect).not.toHaveBeenCalled();
  });

  it("blocks concurrent and nested invocation and unlocks after completion", async () => {
    const pending = gate<typeof inspected>();
    options.inspect = () => pending.promise;
    const tool = createPublishFileTool(options);
    const first = tool.execute("call-1", { path: "report.txt" }, undefined, undefined, context);
    await expect(tool.execute("call-2", { path: "second.txt" }, undefined, undefined, context)).rejects.toThrow(/^文件发布失败$/);
    pending.release(inspected);
    await first;
    options.inspect = async () => {
      await expect(tool.execute("nested", { path: "nested.txt" }, undefined, undefined, context)).rejects.toThrow(/^文件发布失败$/);
      return inspected;
    };
    await tool.execute("call-2", { path: "report.txt" }, undefined, undefined, context);
    expect(manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === PUBLISHED_FILE_TYPE)).toHaveLength(2);
  });

  it.each(["", "bad\0path"])("rejects invalid paths without inspection: %j", async (path) => {
    await expect(createPublishFileTool(options).execute("call-1", { path }, undefined, undefined, context)).rejects.toThrow(/^文件发布失败$/);
    expect(options.inspect).not.toHaveBeenCalled();
  });

  it.each([
    { sourcePath: "not-absolute" }, { sourcePath: "/external/../report.txt" }, { byteLength: 50 * 1024 * 1024 + 1 },
    { fileName: "bad\nname" }, { mimeType: "invalid" },
  ])("fails closed for invalid inspection metadata: %j", async (overrides) => {
    options.inspect = async () => ({ ...inspected, ...overrides });
    await expect(createPublishFileTool(options).execute("call-1", { path: "report.txt" }, undefined, undefined, context)).rejects.toThrow(/^文件发布失败$/);
    expect(manager.getEntries().some((entry) => entry.type === "custom")).toBe(false);
  });

  it("sanitizes inspect errors and can run again after a failure", async () => {
    options.inspect = vi.fn().mockRejectedValueOnce(new Error("private /secret/token")).mockResolvedValueOnce(inspected);
    const tool = createPublishFileTool(options);
    await expect(tool.execute("call-1", { path: "report.txt" }, undefined, undefined, context)).rejects.toThrow(/^文件发布失败$/);
    await expect(tool.execute("call-2", { path: "report.txt" }, undefined, undefined, context)).resolves.toHaveProperty("details.publication_id");
  });

  it.each(["before-write", "after-write"])("throws on append failure %s; residual custom never becomes eligible", async (mode) => {
    const persist = manager._persist.bind(manager);
    vi.spyOn(manager, "_persist").mockImplementationOnce((entry) => {
      if (mode === "after-write") persist(entry);
      throw new Error("private /disk/path");
    });
    const tool = createPublishFileTool(options);
    await expect(tool.execute("call-1", { path: "report.txt" }, undefined, undefined, context)).rejects.toThrow(/^文件发布失败$/);
    const orphan = manager.getLeafEntry()!.id;
    manager.appendMessage({ role: "toolResult", toolName: tool.name, toolCallId: "call-1", isError: true,
      content: [{ type: "text", text: "文件发布失败" }], details: { publication_id: orphan }, timestamp: 2 });
    expect(collectPublications(manager).size).toBe(0);
    const reopened = SessionManager.open(manager.getSessionFile()!, join(directory, "sessions"));
    expect(collectPublications(reopened).size).toBe(0);
  });
});
