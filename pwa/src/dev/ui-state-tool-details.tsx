import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, NativeSelect } from "@mantine/core";
import { toolDetailsContentSchema, type ClientFrame, type ToolDetailsContent, type ToolRef } from "@pi-reach/protocol/session";
import { encodeBase64 } from "@/lib/pi-reach/encoding";
import { ToolDetailsController, type ToolDetailsConnection } from "@/lib/pwa/tool-details";
import { toolDetailsCacheKey, type ToolDetailsCache, type ToolDetailsCacheScope } from "@/lib/pwa/tool-details-cache";
import type { ToolDetailsView } from "@/components/pwa/tool-details-context";
import { galleryToolDetails } from "./ui-state-fixtures";

type OpenFrame = Extract<ClientFrame, { type: "tool_details_open" }>;
export type GalleryDetailsReply = "loading" | "details" | "complete" | "retry" | "error";
/** 「预览后完成」从预览到正式结果的间隔：留出看清预览的时间，不随动画慢放改变。 */
export const DETAILS_COMPLETE_MS = 1500;
const NO_COMPLETED: ReadonlySet<string> = new Set();
const GALLERY_CHANNEL_ID = "gallery-channel";
// 与演示时间线的 session、leaf 一致，正式控制器才会接受演示返回的详情。
const GALLERY_SESSION_ID = "ui-states";
const GALLERY_LEAF_ID = "leaf";
const GALLERY_SCOPE: ToolDetailsCacheScope = { ownerId: "gallery-owner", deviceId: "gallery-computer", endpointId: "gallery-live", sessionId: GALLERY_SESSION_ID };

/** 完整详情只缓存在本页内存，再次打开直接命中；不打开 IndexedDB。 */
class MemoryToolDetailsCache implements ToolDetailsCache {
  private readonly records = new Map<string, string>();
  async get(key: string): Promise<ToolDetailsContent | undefined> {
    const text = this.records.get(key);
    return text === undefined ? undefined : toolDetailsContentSchema.parse(JSON.parse(text));
  }
  async put(scope: ToolDetailsCacheScope, groupId: string, ref: ToolRef, text: string): Promise<void> {
    this.records.set(toolDetailsCacheKey(scope, groupId, ref), text);
  }
}

async function chunkFrame(request: OpenFrame, content: ToolDetailsContent, revision = 1) {
  const bytes = new TextEncoder().encode(JSON.stringify(content));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return { protocol_version: 2, type: "tool_details_chunk", target_channel_id: request.channel_id, in_reply_to: request.id, session_id: request.session_id, leaf_id: request.leaf_id,
    group_id: request.group_id, tool_ref: request.tool_ref, revision, index: 0, data_base64: encodeBase64(bytes), final: true, total_bytes: bytes.length,
    sha256: Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") } as const;
}
function errorFrame(request: OpenFrame) {
  return { protocol_version: 2, type: "tool_details_error", target_channel_id: request.channel_id, in_reply_to: request.id, session_id: request.session_id, leaf_id: request.leaf_id,
    group_id: request.group_id, tool_ref: request.tool_ref, revision: 1, code: "unavailable", terminal: true, retryable: true } as const;
}

/**
 * 复用正式详情控制器，连接与缓存换成内存实现。阅读器是模态抽屉，打开后无法操作页面控件，
 * 所以回包方式在打开前选定，请求到达后按选择立即回包，不模拟传输计时。
 */
export function useGalleryToolDetails(sourceKey: string) {
  const [controller] = useState(() => new ToolDetailsController(new MemoryToolDetailsCache()));
  const [online, setOnline] = useState(true);
  const [reply, setReplyState] = useState<GalleryDetailsReply>("details");
  const replyRef = useRef(reply);
  // 「首次失败」按工具记录，切换回包方式后重新开始。
  const failedOnce = useRef(new Set<string>());
  // 已收到正式结果的运行工具；按来源记录，换场景或重放后回到运行中。
  const [completed, setCompleted] = useState<{ sourceKey: string; ids: ReadonlySet<string> }>({ sourceKey, ids: NO_COMPLETED });
  const sourceKeyRef = useRef(sourceKey);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useLayoutEffect(() => { sourceKeyRef.current = sourceKey; }, [sourceKey]);
  // 卸载时取消订阅与待完成的演示，清除控制器的续租计时器。
  useEffect(() => {
    const pending = timers.current;
    return () => { for (const timer of pending) clearTimeout(timer); pending.clear(); controller.cancel(); };
  }, [controller]);
  const finish = useCallback((request: OpenFrame, source: string) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      const id = request.tool_ref.tool_call_id;
      const content = galleryToolDetails(request.tool_ref, true);
      if (content) void chunkFrame(request, content, 2).then(frame => controller.receive(frame));
      // 正式结果与时间线完成同时发生：阅读器原位换成完整详情，运行行转为完成。
      setCompleted(current => ({ sourceKey: source, ids: new Set([...(current.sourceKey === source ? current.ids : []), id]) }));
    }, DETAILS_COMPLETE_MS);
    timers.current.add(timer);
  }, [controller]);
  const respond = useCallback(async (request: OpenFrame) => {
    const mode = replyRef.current;
    const id = request.tool_ref.tool_call_id;
    if (mode === "loading") return;
    if (mode === "error" || (mode === "retry" && !failedOnce.current.has(id))) {
      failedOnce.current.add(id);
      controller.receive(errorFrame(request));
      return;
    }
    const content = galleryToolDetails(request.tool_ref);
    if (!content) return;
    controller.receive(await chunkFrame(request, content));
    if (mode === "complete" && content.source === "preview") finish(request, sourceKeyRef.current);
  }, [controller, finish]);
  const connection = useCallback((): ToolDetailsConnection => ({
    channelId: GALLERY_CHANNEL_ID, sessionId: GALLERY_SESSION_ID, leafId: GALLERY_LEAF_ID, runtimeInstanceId: "gallery-runtime",
    send: frame => {
      // 等控制器登记完本次请求再回包，避免在 send 内部重入。
      if (frame.type === "tool_details_open") queueMicrotask(() => { void respond(frame); });
      return true;
    },
  }), [respond]);
  const setReply = (next: GalleryDetailsReply) => { replyRef.current = next; failedOnce.current.clear(); setReplyState(next); };
  const view: ToolDetailsView = { controller, scope: GALLERY_SCOPE, sourceKey, online, connection };
  return { view, reply, setReply, online, setOnline, completed: completed.sourceKey === sourceKey ? completed.ids : NO_COMPLETED };
}

export function GalleryToolDetailsControls({ details }: { details: ReturnType<typeof useGalleryToolDetails> }) {
  const { reply, online } = details;
  return <div className="pwa-ui-states-actions">
    <NativeSelect label="详情返回方式" value={reply} onChange={event => details.setReply(event.currentTarget.value as GalleryDetailsReply)} data={[
      { value: "details", label: "返回详情（运行中为预览）" }, { value: "complete", label: "运行中先预览，随后完成" }, { value: "loading", label: "保持加载中" },
      { value: "retry", label: "首次失败，重试后返回" }, { value: "error", label: "始终失败" },
    ]} />
    <Button variant="default" aria-pressed={!online} onClick={() => details.setOnline(!online)}>{online ? "演示离线" : "恢复在线"}</Button>
    <span>阅读器打开后页面控件不可操作，请先选好返回方式。完整详情只缓存在本页内存，再次打开直接显示；离线时未缓存的详情不可用。</span>
  </div>;
}
