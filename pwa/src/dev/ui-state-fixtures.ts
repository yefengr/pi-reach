import { ATTACHMENT_MESSAGE_TYPE, ATTACHMENT_METADATA_TYPE, PUBLISHED_FILE_TYPE, type AttachmentMetadata, type PublishedFileDescriptor } from "@pi-reach/protocol/session";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import type { ComposerAttachmentItem } from "@/components/pwa/attachment-cards";
import type { PublishedFileViewState } from "@/components/pwa/published-files-context";

export type GalleryState = "thinking" | "tools" | "failure" | "long" | "files"
  | "empty" | "offline" | "reconnecting" | "loading" | "models-loading" | "models-error"
  | "uploading" | "pending" | "history" | "summaries" | "delivery" | "flow";
export const GALLERY_STATES: { id: GalleryState; label: string; note: string }[] = [
  { id: "thinking", label: "运行中 · 思考", note: "展开查看思考正文；运行状态仅由本页控件改变。" },
  { id: "tools", label: "运行中 · 工具", note: "运行中的过程组默认展开，点击工具行查看真实详情。" },
  { id: "failure", label: "失败与重试", note: "附件可原位重试；工具重试会替换本页演示结果。" },
  { id: "long", label: "长文字", note: "检查中英文、长路径、Markdown 与代码的阅读和复制。" },
  { id: "files", label: "文件", note: "文本与图片已就绪；获取进度由明确控件演示，不传输文件。" },
  { id: "empty", label: "空会话", note: "正式空态与可编辑输入区，草稿仅保留在本页。" },
  { id: "offline", label: "离线", note: "保留正文与草稿，连接恢复前禁止发送。" },
  { id: "reconnecting", label: "重新连接", note: "正式重连提示；仅点击恢复后改变内存状态。" },
  { id: "loading", label: "会话加载", note: "复用正式延迟骨架；点击完成后展示正文。" },
  { id: "models-loading", label: "模型加载", note: "打开模型设置查看正式加载态，点击完成后展示模型。" },
  { id: "models-error", label: "模型加载失败", note: "打开模型列表查看错误，可显式重试。" },
  { id: "uploading", label: "附件上传", note: "准备、上传 50% 与暂停均可逐项取消；不上传真实文件。" },
  { id: "pending", label: "命令待确认", note: "真实 pending 门禁；点击完成或取消恢复操作。" },
  { id: "history", label: "只读历史", note: "正式历史工作区与只读输入区，不借用实时文件缓存。" },
  { id: "summaries", label: "摘要与服务错误", note: "正式压缩、分支摘要和服务错误阅读入口。" },
  { id: "delivery", label: "消息投递", note: "普通待发送不占状态行；未知可核对、失败可重试、排队可撤回。" },
  { id: "flow", label: "连续运行流程", note: "逐步推进流式输出、正式结果与 leaf；最后切换会话关闭旧详情。" },
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
  return { kind: "event", event: { ...base, event_id: "read-result", kind: "tool", tool_call_id: "read-result", tool: "read", args: { path: "pwa/src/components/pwa/reader-shell.tsx" }, ...(status === "error" ? { status: "error" as const, error: "演示读取失败" } : { status: "complete" as const }), truncated: false, result: { content: [{ type: "text", text: status === "error" ? "演示读取失败：文件暂不可用。" : "仅本页演示：重试完成。\n" + "Independent reading content. 保持阅读与对话独立。\n".repeat(60) }] } } };
}
const SENT_ATTACHMENTS: AttachmentMetadata = { version: 1, client_request_id: "sent-request", sender_ref: "gallery-owner", text: "请按这两份材料调整。", attachments: [
  { attachment_id: "sent-photo", file_name: "界面截图.png", mime_type: "image/png", byte_length: 48_213, sha256: "0".repeat(64) },
  { attachment_id: "sent-notes", file_name: "调整说明.md", mime_type: "text/markdown", byte_length: 2_048, sha256: "1".repeat(64) },
] };
/** 已发送附件：元信息、正式消息与绑定三条记录，与真实时间线的投影方式一致。 */
function sentAttachmentItems(): TimelineViewItem[] {
  const { client_request_id, sender_ref } = SENT_ATTACHMENTS;
  return [
    { kind: "event", event: { ...base, event_id: "sent-meta", kind: "custom", truncated: false, payload: { custom_type: ATTACHMENT_METADATA_TYPE, data: SENT_ATTACHMENTS } } },
    { kind: "event", event: { ...base, event_id: "sent-message", kind: "user", message_id: "sent-message", blocks: [{ type: "text", text: SENT_ATTACHMENTS.text }], origin: "pwa", sender_ref, delivery: "normal", status: "committed" } },
    { kind: "event", event: { ...base, event_id: "sent-binding", kind: "custom", truncated: false, payload: { custom_type: ATTACHMENT_MESSAGE_TYPE, data: { version: 1, client_request_id, sender_ref, message_id: "sent-message" } } } },
  ];
}
export function galleryItems(state: GalleryState, retried: boolean): TimelineViewItem[] {
  if (state === "thinking") return [text("intro", "正在整理阅读布局。"), { kind: "partial", createdAt: 2, partial: { protocol_version: 2, type: "timeline_partial", ...base, partial_id: "thinking", kind: "thinking", status: "delta", delta: "**检查阅读与输入的关系**\n\n在本页展开思考，检查标题、正文和运行提示。没有连接远程会话。" } }];
  if (state === "tools") return [text("intro", "正在检查工作面板；点击工具行查看原始输出。"), { kind: "partial", createdAt: 2, partial: { protocol_version: 2, type: "timeline_partial", ...base, partial_id: "tool:check", kind: "tool", tool_call_id: "check", tool: "bash", args: { command: "pnpm typecheck" }, status: "running", blocks: [{ type: "text", text: "演示输出：正在检查类型。\n此命令没有实际执行。" }] } }];
  if (state === "failure") return [tool(retried ? "complete" : "error"), text("failure-note", retried ? "演示工具重试已完成。" : "工具失败保留原始输出，附件失败保留独立重试入口。")];
  if (state === "long") return [text("long", `## 阅读与换行\n\n中英文正文保持原有排版。Long English text should wrap inside the reading column without widening the page.\n\n\`pwa/src/components/pwa/very-long-directory-name/another-long-directory-name/reader-drawer-and-state.tsx\`\n\n> 阅读位置和输入草稿应在宽度切换时保持。\n\n\`\`\`typescript\n${GALLERY_CODE}\n\`\`\`\n\n| 状态 | 说明 |\n| --- | --- |\n| 内存 | 不连接远程服务 |\n| 草稿 | 仅保留在本页 |\n\n${"长段落用于检查自然换行。Keep the reading column comfortable. ".repeat(14)}`)];
  if (state !== "files") return conversationItems(state);
  const publications: TimelineViewItem[] = GALLERY_FILES.map(({ publication_id, ...data }) => ({ kind: "event", event: { ...base, event_id: publication_id, kind: "custom", truncated: false, payload: { custom_type: PUBLISHED_FILE_TYPE, data } } }));
  return [...sentAttachmentItems(), tool("complete"), ...publications];
}
export const GALLERY_FLOW_STEPS = ["思考开始", "思考增长", "思考完成 · 工具运行", "工具输出增长", "正式完成 · leaf 推进", "追加消息与文件", "切换内存会话"];
const flowThought = "**检查连续运行**\n\n先检查草稿与阅读位置。";
const flowOutput = "演示工具输出：未执行命令。\n";

export function galleryFlowItems(step: number): TimelineViewItem[] {
  if (step === 6) return [{ kind: "event", event: { ...base, session_id: "ui-states-next", event_id: "next-session", kind: "assistant", status: "complete", blocks: [{ type: "text", text: "已切换到另一内存会话，旧来源已移除。" }] } }];
  const thought = flowThought + (step >= 1 ? "\n\n**保持阅读上下文**\n正文继续增长，展开选择保持不变。" : "");
  const items: TimelineViewItem[] = [step < 2
    ? { kind: "partial", createdAt: 2, partial: { protocol_version: 2, type: "timeline_partial", ...base, partial_id: "flow-answer:thinking:0", kind: "thinking", status: "delta", delta: thought } }
    : { kind: "event", event: { ...base, event_id: "flow-answer", kind: "assistant", status: "complete", blocks: [{ type: "thinking", text: thought }] } }];
  if (step < 2) return items;
  const output = flowOutput + (step >= 3 ? "追加输出：阅读器继续显示同一工具。\n" + "保持滚动与输入草稿。\n".repeat(45) : "");
  items.push(step < 4
    ? { kind: "partial", createdAt: 3, partial: { protocol_version: 2, type: "timeline_partial", ...base, partial_id: "tool:flow-check", kind: "tool", tool_call_id: "flow-check", tool: "bash", args: { command: "pnpm typecheck" }, status: "running", blocks: [{ type: "text", text: output }] } }
    : { kind: "event", event: { ...base, leaf_id: "leaf-next", event_id: "flow-result", kind: "tool", tool_call_id: "flow-check", tool: "bash", args: { command: "pnpm typecheck" }, status: "complete", truncated: false, result: { content: [{ type: "text", text: output + "正式结果：检查完成。" }] } } });
  if (step >= 4) items.push({ kind: "event", event: { ...base, leaf_id: "leaf-next", event_id: "flow-end", kind: "run_end", status: "complete", timestamp: 1000 } });
  if (step >= 5) items.push(text("flow-followup", "新的普通消息不会抢占已选中的工具详情。"), { kind: "event", event: { ...base, leaf_id: "leaf-latest", event_id: "notes", kind: "custom", truncated: false, payload: { custom_type: PUBLISHED_FILE_TYPE, data: { file_name: GALLERY_FILES[0].file_name, mime_type: GALLERY_FILES[0].mime_type, byte_length: GALLERY_FILES[0].byte_length, tool_call_id: "publish" } } } });
  return items;
}

function conversationItems(state: GalleryState): TimelineViewItem[] {
  if (state === "empty" || state === "loading") return [];
  if (state === "flow") return galleryFlowItems(0);
  if (state === "summaries") return [
    { kind: "event", event: { ...base, event_id: "compact", kind: "compaction", truncated: false, payload: { summary: "## 上下文摘要\n\n保留当前目标、草稿与阅读上下文。" } } },
    { kind: "event", event: { ...base, event_id: "branch", kind: "branch_summary", truncated: false, payload: { summary: "## 分支摘要\n\n此分支使用内存中的演示数据。" } } },
    { kind: "event", event: { ...base, event_id: "provider", kind: "provider_error", message: "演示服务暂不可用，请稍后重试。" } },
  ];
  if (state === "delivery") return [
    { kind: "pending", id: "sending", clientRequestId: "sending", requestId: "sending", createdAt: 1, text: "这条消息正在等接收回执，气泡下方不再显示发送状态。", delivery: "pending" },
    { kind: "pending", id: "unknown", clientRequestId: "unknown", requestId: "unknown", createdAt: 2, text: "这条消息的投递状态未知。", delivery: "unknown_delivery" },
    { kind: "pending", id: "failed", clientRequestId: "failed", requestId: "failed", createdAt: 3, text: "这条消息没有发送出去。", delivery: "failed", deliveryFailure: { code: "transport_unavailable", retryable: true } },
    { kind: "pending", id: "queued", clientRequestId: "queued", requestId: "queued", createdAt: 4, text: "这条排队消息可以取消。", delivery: "accepted", cancelable: true },
  ];
  if (state === "history") return [
    ...Array.from({ length: 36 }, (_, index): TimelineViewItem => ({ kind: "event", event: { ...base, session_id: "gallery-history", event_id: `history-${index}`, event_seq: index + 1, kind: "assistant", status: "complete", blocks: [{ type: "text", text: `已保存的演示记录 ${index + 1}。只读内容不修改当前草稿。` }] } })),
    { kind: "event", event: { ...base, session_id: "gallery-history", event_id: "notes", event_seq: 37, kind: "custom", truncated: false, payload: { custom_type: PUBLISHED_FILE_TYPE, data: { file_name: GALLERY_FILES[0].file_name, mime_type: GALLERY_FILES[0].mime_type, byte_length: GALLERY_FILES[0].byte_length, tool_call_id: "publish" } } } },
  ];
  return [text("conversation", "这是本页内存中的演示会话；所有状态由明确操作改变。")];
}

export function galleryUploadingAttachments(): ComposerAttachmentItem[] {
  return [
    { id: "preparing", fileName: "准备中的附件.txt", byteLength: 2048, status: "preparing" },
    { id: "uploading", fileName: "上传中的附件.txt", byteLength: 4096, receivedBytes: 2048, status: "uploading" },
    { id: "paused", fileName: "暂停的附件.txt", byteLength: 2048, status: "paused" },
  ];
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
