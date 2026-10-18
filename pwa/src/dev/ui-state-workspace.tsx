import { useCallback, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@mantine/core";
import { MessageComposer } from "@/components/pwa/message-composer";
import { MessageList } from "@/components/pwa/message-list";
import { WorkPanelLayout } from "@/components/pwa/work-panel-layout";
import { PublishedFilesProvider, type PublishedFilesView, type PublishedFileViewState } from "@/components/pwa/published-files-context";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import type { ThinkingLevel } from "@/lib/pi-reach/types";
import { UI_REVIEW_MODELS } from "./ui-review-fixtures";
import { createGalleryAssets, galleryAttachment, galleryItems, type GalleryState } from "./ui-state-fixtures";

function GalleryTimeline({ state }: { state: GalleryState }) {
  const [retried, setRetried] = useState(false);
  const items = useMemo(() => galleryItems(state, retried), [state, retried]);
  const viewport = useTimelineViewport(items);
  return <>
    {state === "failure" ? <div className="pwa-ui-states-actions"><Button variant="default" disabled={retried} onClick={() => setRetried(true)}>演示工具重试</Button></div> : null}
    <MessageList items={items} hasEarlier={false} running={state === "thinking" || state === "tools"}
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
  const scopeToken = useMemo(() => ({ state }), [state]);
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
    scopeToken, canFetch: true, active: false,
    getState: id => currentStates.current.get(id),
    open: async (descriptor, intent) => {
      if (intent === "auto" || !assets.current) return;
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
  return <PublishedFilesProvider value={files}>
    {state === "files" ? <div className="pwa-ui-states-actions"><Button variant="default" disabled={states.get("reading")?.phase === "ready"} onClick={() => {
      if (!assets.current) return;
      const next = new Map(currentStates.current);
      next.set("reading", assets.current.ready("reading"));
      updateStates(next);
    }}>演示获取完成</Button><span>获取中固定为 50%，只在点击后改变。</span></div> : null}
    <WorkPanelLayout>
      <GalleryTimeline key={state} state={state} />
      <div className="pwa-chat-footer" ref={initializeAssets}>
        <MessageComposer enterSends={true} draft={draft} onDraftChange={setDraft} attachmentNotice={result}
          attachments={state === "failure" && attachmentVisible ? [attachment] : []} canAttach={false} sendingAttachments={false}
          isOnline isWorking={state === "thinking" || state === "tools"} stopping={false}
          onSend={() => setResult("已演示发送，草稿保留；未发送到 Pi。")} onStop={() => setResult("已演示停止；通过上方控件切换状态。")}
          onAddFiles={() => {}} onRemoveAttachment={() => setAttachmentVisible(false)}
          onRetryAttachment={() => { setAttachment(previous => ({ ...previous, status: "complete", errorText: undefined })); setResult("演示附件重试完成，未上传文件。"); }}
          commandModels={UI_REVIEW_MODELS} commandModelsStatus="success" commandCurrentModel={model} commandCurrentModelFallback={null}
          commandThinking={thinking} commandPendingAction={null} onSetModel={setModel} onSetThinking={setThinking} onCommandsOpen={() => {}}
          onNewSession={() => setResult("已演示新会话，草稿保留；未创建远程会话。")}
          onCompactSession={() => setResult("已演示压缩；未执行远程操作。")} />
      </div>
    </WorkPanelLayout>
  </PublishedFilesProvider>;
}
