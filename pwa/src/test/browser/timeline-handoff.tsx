import { useRef, useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { vi } from "vitest";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { useTimeline } from "@/lib/pwa/use-timeline";
import type { TimelineScope } from "@/lib/pwa/timeline-runtime";
import type { PeerChannel } from "@/lib/pi-reach/peer-channel";
import type { ServerFrame } from "@/lib/pi-reach/protocol-v2/frames";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { MessageList } from "@/components/pwa/message-list";
import { isQueuedMessage, QueuedMessagesPanel } from "@/components/pwa/queued-messages-panel";
import { MessageComposer } from "@/components/pwa/message-composer";
import "@/app/workspace-viewport.css";

/** 回放夹具使用的固定身份；测试断言几何与交接时不依赖真实设备或会话。 */
export const HANDOFF_SCOPE: TimelineScope = {
  deviceId: "handoff-device",
  endpointId: "handoff-endpoint",
  runtimeInstanceId: "handoff-runtime",
  sessionId: "handoff-session",
  leafId: "handoff-leaf",
  selfSenderRef: "handoff-sender",
  channelId: "handoff-channel",
};

type HandoffTimeline = ReturnType<typeof useTimeline>;

type HandoffHarnessOptions = {
  width?: number;
  height?: number;
  initialEvents: TimelineEvent[];
  running?: boolean;
};

export type HandoffHarness = {
  screen: Awaited<ReturnType<typeof renderPwa>>;
  list: HTMLDivElement;
  header: HTMLElement;
  input: HTMLTextAreaElement;
  footer: HTMLElement;
  timeline: () => HandoffTimeline;
  receive: (frame: ServerFrame) => void;
  commit: (event: TimelineEvent) => void;
  running: (value: boolean) => void;
};

const noop = () => {};

/** 空草稿的输入区基线；与 message-send.browser.test.tsx 保持一致，只替换与运行状态相关的 props。 */
const composer: ComponentProps<typeof MessageComposer> = {
  enterSends: true, attachments: [], canAttach: true, sendingAttachments: false,
  isOnline: true, isWorking: false, stopping: false, draft: "", onDraftChange: noop,
  onSend: noop, onStop: noop, onAddFiles: noop, onRemoveAttachment: noop, onRetryAttachment: noop,
  commandModels: [], commandCurrentModel: null, commandCurrentModelFallback: null,
  commandThinking: "off", commandPendingAction: null, onNewSession: noop, onCompactSession: noop,
  onSetModel: noop, onSetThinking: noop, onCommandsOpen: noop,
};

/** 只推进真实 RAF；假时钟由 installHandoffClock 在初始几何稳定后才接管。 */
async function frames(count = 3) {
  for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`handoff harness missing ${selector}`);
  return node;
}

/**
 * 以真实 useTimeline 回放时间线交接：不做状态简化，Runtime、StreamDisplayScheduler、
 * StreamDisplayBuffer 与排队出队检测都按产品路径运行。初始事件在渲染完成后再由外部
 * 一次写入权威与显示，保证起点几何稳定。
 */
export async function renderHandoffHarness({ width = 390, height = 650, initialEvents, running = true }: HandoffHarnessOptions): Promise<HandoffHarness> {
  await page.viewport(width, height);
  const captured: { timeline?: HandoffTimeline; setRunning?: (value: boolean) => void } = {};
  function Harness() {
    const [isRunning, updateRunning] = useState(running);
    // 通道固定为 null：回放期间不产生任何外发帧。
    const channelRef = useRef<PeerChannel | null>(null);
    const timeline = useTimeline({ channelRef, reportHistoryFailure: noop });
    captured.timeline = timeline;
    captured.setRunning = updateRunning;
    return <div className="pwa-app-shell"><main className="pwa-main" style={{ display: "flex", flexDirection: "column", width: "100vw", height, flex: "none" }}>
      <header data-testid="handoff-header" style={{ flex: "0 0 48px", display: "flex", alignItems: "center", padding: "0 16px" }}>Handoff</header>
      <MessageList items={timeline.items.filter((item) => !isQueuedMessage(item))} isLive running={isRunning} hasEarlier={false} listRef={timeline.messageListRef} bottomSentinelRef={timeline.bottomSentinelRef} onScroll={timeline.handleScroll} onRetryFailed={noop} onCheckStatus={noop} />
      <div className="pwa-chat-footer"><MessageComposer {...composer} isWorking={isRunning} queuedMessages={<QueuedMessagesPanel items={timeline.items} onCommit={timeline.reportQueueCommit} isOnline isWorking={isRunning} runtimeRef={timeline.runtimeRef} channelRef={channelRef} applyChange={timeline.applyTimelineChange} onError={noop} />} /></div>
    </main></div>;
  }
  const screen = await renderPwa(<Harness />);
  const timeline = () => {
    const current = captured.timeline;
    if (!current) throw new Error("handoff timeline not mounted");
    return current;
  };
  const apply = (change: Parameters<HandoffTimeline["applyTimelineChange"]>[0], resetDisplay?: boolean) => timeline().applyTimelineChange(change, resetDisplay);
  // 先装载 scope 与全部初始记录，再一次性发布权威与显示快照。
  flushSync(() => {
    const runtime = timeline().runtimeRef.current;
    let change = runtime.setScope(HANDOFF_SCOPE);
    for (const event of initialEvents) change = runtime.commit(event);
    apply(change, true);
  });
  await frames(4);
  return {
    screen,
    list: query<HTMLDivElement>(".pwa-message-list"),
    header: query<HTMLElement>("[data-testid='handoff-header']"),
    input: query<HTMLTextAreaElement>(".pwa-composer-input"),
    footer: query<HTMLElement>(".pwa-chat-footer"),
    timeline,
    receive: (frame) => flushSync(() => apply(timeline().runtimeRef.current.receive(frame))),
    commit: (event) => flushSync(() => apply(timeline().runtimeRef.current.commit(event))),
    running: (value) => flushSync(() => captured.setRunning?.(value)),
  };
}

/**
 * 受控帧时钟：只在初始几何稳定后接管 performance.now 与 RAF。
 * step 以真实安装时刻为基准，执行当帧已登记的回调；执行期间新登记的回调留到下一帧。
 */
export function installHandoffClock() {
  const base = performance.now();
  let now = base;
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
  const frameSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { callbacks.delete(id); });
  return {
    step: (elapsedMs: number) => {
      now = base + elapsedMs;
      const pending = [...callbacks.values()];
      callbacks.clear();
      flushSync(() => { for (const callback of pending) callback(now); });
    },
    pending: () => callbacks.size,
    restore: () => {
      callbacks.clear();
      nowSpy.mockRestore();
      frameSpy.mockRestore();
      cancelSpy.mockRestore();
    },
  };
}
