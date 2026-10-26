import { useRef, useState, type RefObject } from "react";
import { Button } from "@mantine/core";
import { MessageComposer } from "@/components/pwa/message-composer";
import { MessageList } from "@/components/pwa/message-list";
import { useI18n } from "@/lib/i18n";
import { useKeyboardViewport } from "@/lib/pwa/use-keyboard-viewport";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { DOCUMENT_LOCK_BYPASS_SUFFIX, KEYBOARD_DIAGNOSTICS_MODES, type KeyboardDiagnosticsMode, type KeyboardDiagnosticsReports } from "@/lib/pwa/keyboard-diagnostics";
import { useKeyboardDiagnostics } from "./use-keyboard-diagnostics";
import { KeyboardDiagnosticsContent } from "./keyboard-diagnostics-content";

const items: TimelineViewItem[] = Array.from({ length: 4 }, (_, index) => ({ kind: "event", event: {
  session_id: "diagnostics", leaf_id: "fixed", event_id: `sample-${index}`, group_id: `sample-${index}`,
  timestamp: 1, kind: "assistant", status: "complete", blocks: [{ type: "text", text:
    `Pi Reach · ${index + 1}\n\nFixed local sample. Focus the input, dismiss the keyboard, then compare the viewport numbers. No message is sent or saved.\n\n本地固定示例。聚焦输入框、收起键盘后比较数值；不会发送或保存消息。` }],
} }));
const noop = () => {};

function KeyboardCompensation({ shellRef }: { shellRef: RefObject<HTMLDivElement | null> }) {
  useKeyboardViewport(shellRef);
  return null;
}

export type InitialDiagnosticsDensity = { compactHeight: string | undefined; wideCompact: boolean };
/** 文档锁旁路只属于 D：其他模式始终为 false，切离 D 即恢复正式锁。 */
export type DiagnosticsExperiment = { mode: KeyboardDiagnosticsMode; documentLockBypass: boolean };

export function KeyboardDiagnosticsStage({ mode, documentLockBypass, initialDensity, onExperiment, reports }: DiagnosticsExperiment & {
  initialDensity: InitialDiagnosticsDensity | null;
  onExperiment: (experiment: DiagnosticsExperiment, density: InitialDiagnosticsDensity) => void; reports: KeyboardDiagnosticsReports;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const controllerRef = mode === "content" ? contentRef : shellRef;
  const textRef = useRef<HTMLPreElement>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");
  const viewport = useTimelineViewport(items);
  const { t } = useI18n();
  const d = t.keyboardDiagnostics;
  const bypassed = mode === "content" && documentLockBypass;
  const { reason, check } = useKeyboardDiagnostics(mode, bypassed, shellRef, controllerRef, textRef, reports);
  const choose = (next: DiagnosticsExperiment) => {
    // disabled 只负责显示；同步复核防同任务聚焦、VV变化或closing事件绕过上一帧状态。
    const shell = controllerRef.current;
    const nextBypass = next.mode === "content" && next.documentLockBypass;
    if ((next.mode === mode && nextBypass === bypassed) || !shell || check() !== "ready") return;
    // 只移交已经由正式hook算出的闭合态标记；native不重造阈值，也不随键盘更新密度。
    onExperiment({ mode: next.mode, documentLockBypass: nextBypass },
      { compactHeight: shell.dataset.compactHeight, wideCompact: shell.hasAttribute("data-wide-compact") });
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(reports.report()); setStatus(t.viewportDebug.copied); }
    catch { setStatus(t.viewportDebug.copyFailed); }
  };
  // 短标记与数值行一致；长文案在窄屏会让标题换行，破坏两组 Chrome 等高。
  const label = bypassed ? `${mode}${DOCUMENT_LOCK_BYPASS_SUFFIX}` : mode;
  const chrome = <><header className="pwa-title-bar"><strong>{d.title}</strong><span>{label}</span></header>
      <section className="pwa-keyboard-diagnostics-controls" aria-label={d.title}>
        <div className="pwa-keyboard-diagnostics-modes" role="group" aria-label={d.modes}>
          {KEYBOARD_DIAGNOSTICS_MODES.map(value => <Button key={value} type="button" variant={value === mode ? "filled" : "default"}
            data-mode={value} aria-pressed={value === mode} aria-describedby="diagnostics-gate" disabled={reason !== "ready"}
            onPointerDown={event => event.preventDefault()} onClick={() => choose({ mode: value, documentLockBypass: false })}>{d[value]}</Button>)}
        </div>
        <p id="diagnostics-gate" role="status">{d[reason]} {d.nativeWarning}</p>
        {/* 配对开关收在折叠说明内，关闭后两组 Chrome 高度一致，不新增常驻行挤压输入区。 */}
        <details><summary>{d.instructions}</summary><p>{d.steps}</p><p>{d.isolation}</p>
          <Button type="button" variant={bypassed ? "filled" : "default"} data-document-lock-toggle aria-pressed={bypassed}
            aria-describedby="diagnostics-gate" disabled={mode !== "content" || reason !== "ready"}
            onPointerDown={event => event.preventDefault()}
            onClick={() => choose({ mode, documentLockBypass: !bypassed })}>{d.documentLockBypass}</Button>
          <p>{d.documentLockHint}</p>
        </details>
        <div className="pwa-keyboard-diagnostics-actions">
          <a href="/app">{d.back}</a><a href="/app/keyboard-diagnostics">{d.restartLink}</a>
          <Button variant="subtle" type="button" onClick={() => void copy()}>{t.viewportDebug.copy}</Button>
          <span role="status">{status}</span>
        </div>
        <pre ref={textRef} aria-label={d.numbers} />
      </section></>;
  const body = <div className="pwa-workspace-body"><div className="pwa-workspace-column">
        <MessageList items={items} hasEarlier={false} listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} onReadingChange={viewport.setReadingDetails} />
        <div className="pwa-chat-footer"><MessageComposer enterSends={false} attachments={[]} canAttach={false} sendingAttachments={false}
          isOnline isWorking={false} stopping={false} draft={draft} onDraftChange={setDraft} onSend={noop} onStop={noop}
          onAddFiles={noop} onRemoveAttachment={noop} onRetryAttachment={noop} commandModels={[]} commandCurrentModel={null}
          commandCurrentModelFallback={null} commandThinking="off" commandPendingAction={null} onNewSession={noop}
          onCompactSession={noop} onSetModel={noop} onSetThinking={noop} onCommandsOpen={noop} /></div>
      </div></div>;
  return <><div ref={shellRef} className="pwa-app-shell pwa-keyboard-diagnostics" data-diagnostics-mode={mode}
    data-document-lock-bypass={bypassed ? "" : undefined}
    data-compact-height={mode === "native" ? initialDensity?.compactHeight : undefined}
    data-wide-compact={mode === "native" && initialDensity?.wideCompact ? "" : undefined}>
    <div className="pwa-root" data-sidebar-collapsed><main className="pwa-main">
      {mode === "content" ? <KeyboardDiagnosticsContent controllerRef={contentRef} chrome={chrome}>{body}</KeyboardDiagnosticsContent> : <>{chrome}{body}</>}
    </main></div>
  </div>{mode !== "native" ? <KeyboardCompensation shellRef={controllerRef} /> : null}</>;
}
