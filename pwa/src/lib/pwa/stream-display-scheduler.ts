import { StreamDisplayBuffer } from "./stream-display-buffer";
import type { TimelineViewItem } from "./timeline-runtime";

/** 无 rAF 时的等间隔提交周期。 */
const FALLBACK_FRAME_MS = 16;
/** rAF 提交的最小间隔：60Hz 每帧提交，120Hz 隔帧提交，限制 Markdown 渲染频率。 */
const MIN_FRAME_INTERVAL_MS = 12;
type PublishDisplay = (items: TimelineViewItem[], realtime: boolean) => void;
type FrameHandle = { cancel(): void };

/** 跟随显示刷新提交；无 rAF 的环境（Node 测试、后台 Worker）退回等间隔定时器。 */
function requestDisplayFrame(run: () => void): FrameHandle {
  if (typeof requestAnimationFrame === "function") {
    const requestedAt = performance.now();
    let frame = 0;
    const tick = () => {
      if (performance.now() - requestedAt < MIN_FRAME_INTERVAL_MS) frame = requestAnimationFrame(tick);
      else run();
    };
    frame = requestAnimationFrame(tick);
    return { cancel: () => cancelAnimationFrame(frame) };
  }
  const timer = setTimeout(run, FALLBACK_FRAME_MS);
  return { cancel: () => clearTimeout(timer) };
}

/** 仅调度显示：不缓存帧、不参与接收、确认或持久化。 */
export class StreamDisplayScheduler {
  private timer: FrameHandle | null = null;
  private epoch = 0;
  private hidden = false;
  private dirty = false;
  private advancedAt = 0;

  constructor(private readonly buffer: StreamDisplayBuffer, private publish: PublishDisplay) {}

  setPublisher(publish: PublishDisplay): void {
    this.publish = publish;
  }

  update(items: readonly TimelineViewItem[], reset = false): void {
    if (reset) this.cancel();
    const wasPending = this.buffer.hasPending();
    const change = reset ? this.buffer.reset(items) : this.buffer.ingest(items);
    if (!wasPending && change.hasPending) this.advancedAt = performance.now();
    this.dirty ||= change.shouldRender;
    if (this.hidden) return;
    if (reset || change.urgent) {
      this.clearTimer();
      this.publish(change.items, false);
      this.dirty = false;
    }
    this.schedule();
  }

  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.cancel();
    if (!hidden) this.publish(this.buffer.flush().items, true);
  }

  /** 生命周期边界同时作废已入任务队列但尚未执行的旧回调。 */
  cancel(): void {
    this.clearTimer();
    this.dirty = false;
    this.advancedAt = performance.now();
  }

  private clearTimer(): void {
    this.epoch += 1;
    this.timer?.cancel();
    this.timer = null;
  }

  private schedule(): void {
    if (this.hidden || this.timer !== null || (!this.dirty && !this.buffer.hasPending())) return;
    const epoch = this.epoch;
    this.timer = requestDisplayFrame(() => {
      if (epoch !== this.epoch || this.hidden) return;
      this.timer = null;
      const now = performance.now();
      const change = this.buffer.advance(now - this.advancedAt);
      this.advancedAt = now;
      if (this.dirty || change.shouldRender) this.publish(change.items, true);
      this.dirty = false;
      this.schedule();
    });
  }
}
