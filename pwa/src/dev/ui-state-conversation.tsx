import { useMemo, useState } from "react";
import { Button } from "@mantine/core";
import type { ComposerCommandAction, ModelListStatus } from "@/components/pwa/composer-command-menu";
import { HistoryConversation } from "@/components/pwa/workspace-content";
import { useDelayedVisibility } from "@/components/pwa/use-delayed-visibility";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import { GALLERY_FLOW_STEPS, galleryFlowItems, galleryItems, galleryUploadingAttachments, type GalleryState } from "./ui-state-fixtures";

function initialConversation(state: GalleryState, epoch = 0) {
  const pending: ComposerCommandAction | null = state === "pending" ? "session_new" : null;
  return {
    state, epoch, step: 0, recovered: false, loaded: false, modelsReady: false, modelsRequested: false,
    pending,
    uploads: galleryUploadingAttachments(), unknownChecked: false, failedRetried: false, queuedCancelled: false, delivered: false,
  };
}

/** 演示只改变内存数据；推进一帧不改变真实会话 scope。 */
export function useGalleryConversation(state: GalleryState) {
  const [local, setLocal] = useState(() => initialConversation(state));
  if (local.state !== state) setLocal(initialConversation(state, local.epoch + 1));
  const online = local.recovered || (state !== "offline" && state !== "reconnecting");
  const loading = state === "loading" && !local.loaded;
  const skeletonVisible = useDelayedVisibility(loading);
  const items = useMemo(() => {
    if (state === "flow") return galleryFlowItems(local.step);
    if (state === "loading" && local.loaded) return galleryItems("offline", false);
    if (state !== "delivery") return galleryItems(state, false);
    if (local.delivered) return galleryItems("offline", false);
    return galleryItems("delivery", false).flatMap<TimelineViewItem>(item => {
      if (item.kind !== "pending") return [item];
      if (item.id === "queued" && local.queuedCancelled) return [];
      if (item.id === "unknown" && local.unknownChecked) return [{ ...item, delivery: "pending" as const }];
      if (item.id === "failed" && local.failedRetried) return [{ ...item, delivery: "pending" as const, deliveryFailure: undefined }];
      return [item];
    });
  }, [state, local.step, local.loaded, local.delivered, local.queuedCancelled, local.unknownChecked, local.failedRetried]);
  const modelsStatus: ModelListStatus = local.modelsReady ? "success"
    : state === "models-loading" ? "loading" : state === "models-error" ? "error" : "success";
  return {
    items, online, loading: loading || skeletonVisible, skeletonVisible, modelsStatus,
    epoch: local.epoch, sourceChanged: state === "flow" && local.step === 6,
    running: online && (state === "thinking" || state === "tools" || (state === "flow" && local.step < 4)),
    step: local.step, pending: local.pending, uploads: local.uploads, delivered: local.delivered,
    recover: () => setLocal(value => ({ ...value, recovered: true })),
    completeLoading: () => setLocal(value => ({ ...value, loaded: true })),
    completeModels: () => setLocal(value => ({ ...value, modelsReady: true })),
    // Composer 的公开 API 同时用于首次打开和点击重试：首次仅标记请求，后续请求交接成功数据。
    requestModels: () => setLocal(value => ({ ...value, modelsRequested: true, modelsReady: value.modelsReady || (state === "models-error" && value.modelsRequested) })),
    completePending: () => setLocal(value => ({ ...value, pending: null })),
    removeUpload: (id: string) => setLocal(value => ({ ...value, uploads: value.uploads.filter(item => item.id !== id) })),
    completeUploads: () => setLocal(value => ({ ...value, uploads: value.uploads.map(item => ({ ...item, status: "complete", receivedBytes: item.byteLength })) })),
    retryFailed: () => setLocal(value => ({ ...value, failedRetried: true })),
    checkStatus: () => setLocal(value => ({ ...value, unknownChecked: true })),
    cancelQueued: () => setLocal(value => ({ ...value, queuedCancelled: true })),
    completeDelivery: () => setLocal(value => ({ ...value, delivered: true })),
    next: () => setLocal(value => ({ ...value, step: Math.min(value.step + 1, GALLERY_FLOW_STEPS.length - 1) })),
    reset: () => setLocal(value => initialConversation(state, value.epoch + 1)),
  };
}

type Conversation = ReturnType<typeof useGalleryConversation>;

export function GalleryConversationControls({ state, conversation: c, onResult }: { state: GalleryState; conversation: Conversation; onResult: (message: string) => void }) {
  const pendingResult = (cancelled: boolean) => {
    c.completePending();
    onResult(cancelled ? "已取消演示命令，操作已恢复。" : "演示命令完成，操作已恢复；未执行远程操作。");
  };
  if (state === "offline" || state === "reconnecting") return <div className="pwa-ui-states-actions">
    <Button variant="default" disabled={c.online} onClick={c.recover}>演示恢复连接</Button><span>仅恢复本页内存状态。</span>
  </div>;
  if (state === "loading") return <div className="pwa-ui-states-actions"><Button variant="default" disabled={!c.loading} onClick={c.completeLoading}>演示加载完成</Button></div>;
  if (state === "models-loading" || state === "models-error") return <div className="pwa-ui-states-actions">
    <Button variant="default" disabled={c.modelsStatus === "success"} onClick={c.completeModels}>{state === "models-error" ? "演示重试模型" : "演示模型加载完成"}</Button><span>打开输入区模型设置查看正式状态。</span>
  </div>;
  if (state === "uploading") return <div className="pwa-ui-states-actions">
    <Button variant="default" disabled={!c.uploads.some(item => item.status !== "complete")} onClick={c.completeUploads}>演示附件完成</Button><span>进度固定为 50%，卡片可逐项取消。</span>
  </div>;
  if (state === "pending") return <div className="pwa-ui-states-actions">
    <Button variant="default" disabled={c.pending === null} onClick={() => pendingResult(false)}>演示命令完成</Button>
    <Button variant="default" disabled={c.pending === null} onClick={() => pendingResult(true)}>取消演示命令</Button>
  </div>;
  if (state === "delivery") return <div className="pwa-ui-states-actions"><Button variant="default" disabled={c.delivered} onClick={() => { c.completeDelivery(); onResult("演示投递已完成；没有发送真实消息。"); }}>演示投递完成</Button></div>;
  if (state === "flow") return <div className="pwa-ui-states-actions" data-flow-step={c.step}>
    <span role="status">步骤 {c.step + 1}/{GALLERY_FLOW_STEPS.length} · {GALLERY_FLOW_STEPS[c.step]}</span>
    <Button variant="default" disabled={c.step === GALLERY_FLOW_STEPS.length - 1} onClick={c.next}>下一步</Button>
    <Button variant="default" onClick={c.reset}>重放流程</Button>
  </div>;
  return null;
}

/** 与正式工作区相同的只读历史组件；演示数据很短，不分页。 */
export function GalleryHistory({ items }: { items: Conversation["items"] }) {
  const viewport = useTimelineViewport(items);
  const savedEvents = useMemo(() => items.flatMap((item) => item.kind === "event" ? [item.event] : []), [items]);
  return <HistoryConversation sourceKey="gallery-history" onReadingChange={viewport.setReadingDetails} items={items} savedEvents={savedEvents} hasEarlier={false} loadingEarlier={false} loadEarlierFailed={false} onLoadEarlier={() => {}} loading={false} viewport={viewport} modelName="内存演示模型" thinking="medium" />;
}
