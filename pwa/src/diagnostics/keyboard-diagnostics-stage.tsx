import { useRef, useState, type RefObject } from "react";
import { Button } from "@mantine/core";
import { MessageComposer } from "@/components/pwa/message-composer";
import { MessageList } from "@/components/pwa/message-list";
import { useI18n } from "@/lib/i18n";
import { useKeyboardViewport } from "@/lib/pwa/use-keyboard-viewport";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { KEYBOARD_DIAGNOSTICS_MODES, type KeyboardDiagnosticsMode, type KeyboardDiagnosticsReports } from "@/lib/pwa/keyboard-diagnostics";
import { useKeyboardDiagnostics } from "./use-keyboard-diagnostics";

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

export function KeyboardDiagnosticsStage({ mode, initialDensity, onMode, reports }: {
  mode: KeyboardDiagnosticsMode; initialDensity: InitialDiagnosticsDensity | null;
  onMode: (mode: KeyboardDiagnosticsMode, density: InitialDiagnosticsDensity) => void; reports: KeyboardDiagnosticsReports;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLPreElement>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");
  const viewport = useTimelineViewport(items);
  const { t } = useI18n();
  const d = t.keyboardDiagnostics;
  const { reason, check } = useKeyboardDiagnostics(mode, shellRef, textRef, reports);
  const choose = (next: KeyboardDiagnosticsMode) => {
    // disabled 只负责显示；同步复核防同任务聚焦、VV变化或closing事件绕过上一帧状态。
    const shell = shellRef.current;
    if (next === mode || !shell || check() !== "ready") return;
    // 只移交已经由正式hook算出的闭合态标记；native不重造阈值，也不随键盘更新密度。
    onMode(next, { compactHeight: shell.dataset.compactHeight, wideCompact: shell.hasAttribute("data-wide-compact") });
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(reports.report()); setStatus(t.viewportDebug.copied); }
    catch { setStatus(t.viewportDebug.copyFailed); }
  };
  return <><div ref={shellRef} className="pwa-app-shell pwa-keyboard-diagnostics" data-diagnostics-mode={mode}
    data-compact-height={mode === "native" ? initialDensity?.compactHeight : undefined}
    data-wide-compact={mode === "native" && initialDensity?.wideCompact ? "" : undefined}>
    <div className="pwa-root" data-sidebar-collapsed><main className="pwa-main">
      <header className="pwa-title-bar"><strong>{d.title}</strong><span>{mode}</span></header>
      <section className="pwa-keyboard-diagnostics-controls" aria-label={d.title}>
        <div className="pwa-keyboard-diagnostics-modes" role="group" aria-label={d.modes}>
          {KEYBOARD_DIAGNOSTICS_MODES.map(value => <Button key={value} type="button" variant={value === mode ? "filled" : "default"}
            data-mode={value} aria-pressed={value === mode} aria-describedby="diagnostics-gate" disabled={reason !== "ready"}
            onPointerDown={event => event.preventDefault()} onClick={() => choose(value)}>{d[value]}</Button>)}
        </div>
        <p id="diagnostics-gate" role="status">{d[reason]} {d.nativeWarning}</p>
        <details><summary>{d.instructions}</summary><p>{d.steps}</p><p>{d.isolation}</p></details>
        <div className="pwa-keyboard-diagnostics-actions">
          <a href="/app">{d.back}</a><a href="/app/keyboard-diagnostics">{d.restartLink}</a>
          <Button variant="subtle" type="button" onClick={() => void copy()}>{t.viewportDebug.copy}</Button>
          <span role="status">{status}</span>
        </div>
        <pre ref={textRef} aria-label={d.numbers} />
      </section>
      <div className="pwa-workspace-body"><div className="pwa-workspace-column">
        <MessageList items={items} hasEarlier={false} listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} onReadingChange={viewport.setReadingDetails} />
        <div className="pwa-chat-footer"><MessageComposer enterSends={false} attachments={[]} canAttach={false} sendingAttachments={false}
          isOnline isWorking={false} stopping={false} draft={draft} onDraftChange={setDraft} onSend={noop} onStop={noop}
          onAddFiles={noop} onRemoveAttachment={noop} onRetryAttachment={noop} commandModels={[]} commandCurrentModel={null}
          commandCurrentModelFallback={null} commandThinking="off" commandPendingAction={null} onNewSession={noop}
          onCompactSession={noop} onSetModel={noop} onSetThinking={noop} onCommandsOpen={noop} /></div>
      </div></div>
    </main></div>
  </div>{mode !== "native" ? <KeyboardCompensation shellRef={shellRef} /> : null}</>;
}
