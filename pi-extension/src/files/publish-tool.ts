import { resolve } from "node:path";
import { statSync } from "node:fs";
import type { SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PUBLISHED_FILE_TYPE } from "@pi-reach/protocol/session";
import { Type } from "typebox";
import { publicationDataSchema, PUBLISHED_FILE_TOOL_NAME } from "./publications.js";

const parameters = Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export type PublishFileToolOptions = {
  getManager: () => SessionManager | null;
  isCurrent: () => boolean;
  getGeneration: () => number;
  getGroupId: () => string | null;
  /** 仅在共享资源账目中完成 inspection 并关闭句柄后 resolve。 */
  inspect: (absolutePath: string) => Promise<{ sourcePath: string; fileName: string; mimeType: string; byteLength: number }>;
};
export type PublishFileToolDetails = { publication_id: string };
const FAILURE_TEXT = "文件发布失败";
function storedSession(manager: SessionManager, file: string | undefined): boolean {
  try { return manager.isPersisted() && !!file && statSync(file).isFile(); }
  catch { return false; }
}

export function createPublishFileTool(options: PublishFileToolOptions): ToolDefinition<typeof parameters, PublishFileToolDetails> {
  // SDK sequential 是调度约束；此门禁也阻止意外重入或嵌套直接调用。
  let executing = false;
  return {
    name: PUBLISHED_FILE_TOOL_NAME,
    label: "发布文件",
    description: "仅发布面向用户交付的成果，或用户明确要求的文件；不要自动发布所有读取、修改或临时文件。已授权 PWA 可能自动获取受支持的小图片。path 相对当前工作目录或为绝对路径，允许项目外的普通文件；只保存引用，不复制原件。",
    parameters,
    executionMode: "sequential",
    async execute(toolCallId, args, signal, _onUpdate, ctx) {
      if (executing) throw new Error(FAILURE_TEXT);
      executing = true;
      try {
        const manager = options.getManager();
        const generation = options.getGeneration();
        const groupId = options.getGroupId();
        if (!manager) throw new Error(FAILURE_TEXT);
        const sessionId = manager.getSessionId();
        const sessionFile = manager.getSessionFile();
        const valid = (): boolean => options.isCurrent() && !signal?.aborted && !ctx.signal?.aborted
          && options.getGeneration() === generation && options.getManager() === manager
          && ctx.sessionManager === manager && ctx.sessionManager.getSessionId() === sessionId
          && manager.getSessionId() === sessionId && manager.getSessionFile() === sessionFile
          && storedSession(manager, sessionFile);
        if (!valid() || typeof args.path !== "string" || !args.path || args.path.includes("\0")) throw new Error(FAILURE_TEXT);
        const inspected = await options.inspect(resolve(ctx.cwd, args.path));
        const data = publicationDataSchema.parse({
          source_path: inspected.sourcePath,
          file_name: inspected.fileName,
          mime_type: inspected.mimeType,
          byte_length: inspected.byteLength,
          tool_call_id: toolCallId,
          ...(groupId === null ? {} : { group_id: groupId }),
        });
        if (!valid()) throw new Error(FAILURE_TEXT);
        const text = `已发布文件引用：${data.file_name} · ${data.mime_type} · ${data.byte_length} B`;
        const publicationId = manager.appendCustomEntry(PUBLISHED_FILE_TYPE, data);
        // append 后没有可失败的 await；正式资格由随后落盘的成功原生 toolResult 建立。
        return { content: [{ type: "text", text }], details: { publication_id: publicationId } };
      } catch {
        // SDK 会将 throw 转为 isError；不把内部路径或 I/O 异常暴露给消息与日志。
        throw new Error(FAILURE_TEXT);
      } finally {
        executing = false;
      }
    },
  };
}
