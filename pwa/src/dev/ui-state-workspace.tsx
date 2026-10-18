import { useCallback, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@mantine/core";
import { MessageComposer } from "@/components/pwa/message-composer";
import { MessageList } from "@/components/pwa/message-list";
import { PwaConnectionBanner } from "@/components/pwa/pwa-app-actions";
import { PublishedFilesProvider, type PublishedFilesView, type PublishedFileViewState } from "@/components/pwa/published-files-context";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import type { ThinkingLevel } from "@/lib/pi-reach/types";
import { UI_REVIEW_MODELS } from "./ui-review-fixtures";
import { createGalleryAssets, galleryAttachment, galleryItems, type GalleryState } from "./ui-state-fixtures";
import { GalleryConversationControls, GalleryHistory, useGalleryConversation } from "./ui-state-conversation";

function GalleryTimeline({ state, conversation }: { state: GalleryState; conversation: ReturnType<typeof useGalleryConversation> }) {
  const [retried, setRetried] = useState(false);
  const failureItems = useMemo(() => state === "failure" ? galleryItems(state, retried) : null, [state, retried]);
  const items: TimelineViewItem[] = failureItems ?? conversation.items;
  const viewport = useTimelineViewport(items);
  return <>
    {state === "failure" ? <div className="pwa-ui-states-actions"><Button variant="default" disabled={retried} onClick={() => setRetried(true)}>演示工具重试</Button></div> : null}
    <MessageList items={items} hasEarlier={false} running={conversation.running} isLive={conversation.online}
      loading={conversation.loading} skeletonVisible={conversation.skeletonVisible}
      emptyContext={state === "empty" ? "pi-reach · 内存演示模型 · medium" : null}
      onRetryUnknown={conversation.retryDelivery} onCancelQueued={conversation.cancelQueued}
      listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef}
      onScroll={viewport.handleScroll} onReadingChange={viewport.setReadingDetails} />
  </>;
}

export function UiStateWorkspace({ state }: { state: GalleryState }) {
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState(galleryAttachment);
  const [attachmentVisible, setAttachmentVisible] = useState(true);
  const [model, setModel] = useState(UI_REVIEW_MODELS[0]);
  const [thinking, setThinking] = useState<ThinkingLevel>("medium");
  const [result, setResult] = useState("发送、停止与菜单操作只影响本页演示。");
  const [states, setStates] = useState<Map<string, PublishedFileViewState>>(new Map());
  const currentStates = useRef(states);
  const assets = useRef<ReturnType<typeof createGalleryAssets> | null>(null);
  const conversation = useGalleryConversation(state);
  const { epoch, sourceChanged } = conversation;
  const scopeToken = useMemo(() => ({ state, epoch, sourceChanged }), [state, epoch, sourceChanged]);
  const updateStates = (next: Map<string, PublishedFileViewState>) => {
    currentStates.current = next;
    setStates(next);
  };
  const initializeAssets = useCallback(() => {
    const resource = createGalleryAssets();
    assets.current = resource;
    const initial = new Map<string, PublishedFileViewState>([
      ["notes", resource.ready("notes")], ["picture", resource.ready("picture")],
      ["reading", { phase: "reading", receivedBytes: 4096, byteLength: 8192 }],
      ["error", { phase: "error", receivedBytes: 0, error: "not_available" }],
    ]);
    currentStates.current = initial;
    setStates(initial);
    return () => { assets.current = null; resource.dispose(); };
  }, []);
  const files: PublishedFilesView = {
    scopeToken, canFetch: state !== "history" && conversation.online, active: false,
    getState: id => state === "history" ? undefined : currentStates.current.get(id),
    open: async (descriptor, intent) => {
      if (state === "history" || !conversation.online || intent === "auto" || !assets.current) return;
      // 明确点击才交接已存在的内存内容，不模拟传输或业务计时器。
      const next = new Map(currentStates.current);
      next.set(descriptor.publication_id, assets.current.ready(descriptor.publication_id));
      flushSync(() => updateStates(next));
    },
    cancel: () => {
      const next = new Map(currentStates.current);
      next.set("reading", { phase: "manual", receivedBytes: 0, byteLength: 8192 });
      updateStates(next);
    },
    pin() {}, unpin() {},
  };
  const uploading = state === "uploading" && conversation.uploads.some(item => item.status !== "complete");
  return <PublishedFilesProvider value={files}>
    <GalleryConversationControls state={state} conversation={conversation} onResult={setResult} />
    {!conversation.online ? <PwaConnectionBanner kind={state === "offline" ? "network" : "relay"} connection={state === "offline" ? "no_network" : "retrying"} /> : null}
    {state === "files" ? <div className="pwa-ui-states-actions"><Button variant="default" disabled={states.get("reading")?.phase === "ready"} onClick={() => {
      if (!assets.current) return;
      const next = new Map(currentStates.current);
      next.set("reading", assets.current.ready("reading"));
      updateStates(next);
    }}>演示获取完成</Button><span>获取中固定为 50%，只在点击后改变。</span></div> : null}
    <div className="pwa-workspace-body"><div className="pwa-workspace-column">
      {state === "history" ? <GalleryHistory items={conversation.items} /> : <GalleryTimeline key={`${state}:${epoch}`} state={state} conversation={conversation} />}
      <div className="pwa-chat-footer" ref={initializeAssets} hidden={state === "history"} inert={state === "history"} style={state === "history" ? { display: "none" } : undefined}>
        <MessageComposer enterSends={true} draft={draft} onDraftChange={setDraft} attachmentNotice={conversation.online ? result : null}
          attachments={state === "uploading" ? conversation.uploads : state === "failure" && attachmentVisible ? [attachment] : []} canAttach={false} sendingAttachments={uploading}
          isOnline={conversation.online} isWorking={conversation.running} stopping={false}
          onSend={() => setResult("已演示发送，草稿保留；未发送到 Pi。")} onStop={() => setResult("已演示停止；通过上方控件切换状态。")}
          onAddFiles={() => {}} onRemoveAttachment={id => state === "uploading" ? conversation.removeUpload(id) : setAttachmentVisible(false)}
          onRetryAttachment={() => { setAttachment(previous => ({ ...previous, status: "complete", errorText: undefined })); setResult("演示附件重试完成，未上传文件。"); }}
          commandModels={conversation.modelsStatus === "success" ? UI_REVIEW_MODELS : []} commandModelsStatus={conversation.modelsStatus} commandCurrentModel={model} commandCurrentModelFallback={null}
          commandThinking={thinking} commandPendingAction={conversation.pending} onSetModel={setModel} onSetThinking={setThinking} onCommandsOpen={conversation.requestModels}
          onNewSession={() => setResult("已演示新会话，草稿保留；未创建远程会话。")}
          onCompactSession={() => setResult("已演示压缩；未执行远程操作。")} />
      </div>
    </div></div>
  </PublishedFilesProvider>;
}
