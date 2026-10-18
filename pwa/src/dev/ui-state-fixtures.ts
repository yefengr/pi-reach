import { PUBLISHED_FILE_TYPE, type PublishedFileDescriptor } from "@pi-reach/protocol/session";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import type { ComposerAttachmentItem } from "@/components/pwa/attachment-cards";
import type { PublishedFileViewState } from "@/components/pwa/published-files-context";

export type GalleryState = "thinking" | "tools" | "failure" | "long" | "files";
export const GALLERY_STATES: { id: GalleryState; label: string; note: string }[] = [
  { id: "thinking", label: "运行中 · 思考", note: "展开查看思考正文；运行状态仅由本页控件改变。" },
  { id: "tools", label: "运行中 · 工具", note: "展开工具组，再点击工具行查看真实详情。" },
  { id: "failure", label: "失败与重试", note: "附件可原位重试；工具重试会替换本页演示结果。" },
  { id: "long", label: "长文字", note: "检查中英文、长路径、Markdown 与代码的阅读和复制。" },
  { id: "files", label: "文件", note: "文本与图片已就绪；获取进度由明确控件演示，不传输文件。" },
];
const base = { session_id: "ui-states", leaf_id: "leaf", group_id: "demo", timestamp: 1 };
export const GALLERY_CODE = 'const panel = { mode: "memory", connected: false };\nconsole.log(panel);';
export const GALLERY_DOCUMENT = "# 阅读与对话并排\n\n此文件仅在本页内存中生成，不连接 Pi 或 Relay。\n\n" + Array.from({ length: 20 }, (_, index) => `## 阅读段落 ${index + 1}\n\n在空间足够时，详情在右侧打开，输入区保持可用。Keep the draft and reading position while the layout changes.\n\n`).join("");
export const GALLERY_FILES: PublishedFileDescriptor[] = [
  { publication_id: "notes", file_name: "界面演示.md", mime_type: "text/markdown", byte_length: new TextEncoder().encode(GALLERY_DOCUMENT).length, tool_call_id: "publish" },
  { publication_id: "picture", file_name: "内存布局.png", mime_type: "image/png", byte_length: 4096, tool_call_id: "publish" },
  { publication_id: "reading", file_name: "获取中.txt", mime_type: "text/plain", byte_length: 8192, tool_call_id: "publish" },
  { publication_id: "error", file_name: "获取失败.txt", mime_type: "text/plain", byte_length: 4096, tool_call_id: "publish" },
];
function text(id: string, value: string): TimelineViewItem {
  return { kind: "event", event: { ...base, event_id: id, kind: "assistant", status: "complete", blocks: [{ type: "text", text: value }] } };
}
function tool(status: "complete" | "error"): TimelineViewItem {
  return { kind: "event", event: { ...base, event_id: "read-result", kind: "tool", tool_call_id: "read-result", tool: "read", args: { path: "pwa/src/components/pwa/work-panel-layout.tsx" }, ...(status === "error" ? { status: "error" as const, error: "演示读取失败" } : { status: "complete" as const }), truncated: false, result: { content: [{ type: "text", text: status === "error" ? "演示读取失败：文件暂不可用。" : "仅本页演示：重试完成。\n" + "Independent reading content. 保持阅读与对话独立。\n".repeat(60) }] } } };
}
export function galleryItems(state: GalleryState, retried: boolean): TimelineViewItem[] {
  if (state === "thinking") return [text("intro", "正在整理阅读布局。"), { kind: "partial", createdAt: 2, partial: { protocol_version: 2, type: "timeline_partial", ...base, partial_id: "thinking", kind: "thinking", status: "delta", delta: "**检查阅读与输入的关系**\n\n在本页展开思考，检查标题、正文和运行提示。没有连接远程会话。" } }];
  if (state === "tools") return [text("intro", "正在检查工作面板；点击工具行查看原始输出。"), { kind: "partial", createdAt: 2, partial: { protocol_version: 2, type: "timeline_partial", ...base, partial_id: "tool:check", kind: "tool", tool_call_id: "check", tool: "bash", args: { command: "pnpm typecheck" }, status: "running", blocks: [{ type: "text", text: "演示输出：正在检查类型。\n此命令没有实际执行。" }] } }];
  if (state === "failure") return [tool(retried ? "complete" : "error"), text("failure-note", retried ? "演示工具重试已完成。" : "工具失败保留原始输出，附件失败保留独立重试入口。")];
  if (state === "long") return [text("long", `## 阅读与换行\n\n中英文正文保持原有排版。Long English text should wrap inside the reading column without widening the page.\n\n\`pwa/src/components/pwa/very-long-directory-name/another-long-directory-name/work-panel-layout-and-reader-state.tsx\`\n\n> 阅读位置和输入草稿应在宽度切换时保持。\n\n\`\`\`typescript\n${GALLERY_CODE}\n\`\`\`\n\n| 状态 | 说明 |\n| --- | --- |\n| 内存 | 不连接远程服务 |\n| 草稿 | 仅保留在本页 |\n\n${"长段落用于检查自然换行。Keep the reading column comfortable. ".repeat(14)}`)];
  const publications: TimelineViewItem[] = GALLERY_FILES.map(({ publication_id, ...data }) => ({ kind: "event", event: { ...base, event_id: publication_id, kind: "custom", truncated: false, payload: { custom_type: PUBLISHED_FILE_TYPE, data } } }));
  return [tool("complete"), ...publications];
}
export function galleryAttachment(): ComposerAttachmentItem {
  return { id: "attachment", fileName: "演示附件.txt", byteLength: 2048, status: "failed", errorText: "演示发送失败，请重试。" };
}

/** 资源只在挂载期创建；不读取文件、缓存或网络。 */
export function createGalleryAssets() {
  const textUrl = URL.createObjectURL(new Blob([GALLERY_DOCUMENT], { type: "text/markdown" }));
  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 400;
  const context = canvas.getContext("2d")!;
  const style = getComputedStyle(document.documentElement);
  context.fillStyle = style.getPropertyValue("--pwa-panel").trim();
  context.fillRect(0, 0, 640, 400);
  context.fillStyle = style.getPropertyValue("--pwa-ink").trim();
  context.font = `24px ${style.getPropertyValue("--pwa-font-ui")}`;
  context.fillText("Pi Reach · 内存布局", 32, 56);
  context.strokeStyle = style.getPropertyValue("--pwa-control-line").trim();
  context.strokeRect(32, 88, 352, 272); context.strokeRect(408, 88, 200, 272);
  context.fillText("对话", 56, 136); context.fillText("详情", 432, 136);
  const encoded = atob(canvas.toDataURL("image/png").split(",")[1]);
  const image = new Blob([Uint8Array.from(encoded, character => character.charCodeAt(0))], { type: "image/png" });
  const imageUrl = URL.createObjectURL(image);
  const ready = (id: string): PublishedFileViewState => id === "picture"
    ? { phase: "ready", receivedBytes: image.size, byteLength: image.size, preview: { kind: "image", width: 640, height: 400 }, url: imageUrl }
    : { phase: "ready", receivedBytes: GALLERY_FILES[0].byte_length, byteLength: GALLERY_FILES[0].byte_length, preview: { kind: "text" }, text: GALLERY_DOCUMENT, url: textUrl };
  return { ready, dispose: () => { URL.revokeObjectURL(textUrl); URL.revokeObjectURL(imageUrl); } };
}
