import { StreamDisplayBuffer } from "./stream-display-buffer";
import type { TimelineViewItem } from "./timeline-runtime";

const DISPLAY_INTERVAL_MS = 33;
type PublishDisplay = (items: TimelineViewItem[], realtime: boolean) => void;

/** 仅调度显示：不缓存帧、不参与接收、确认或持久化。 */
export class StreamDisplayScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
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
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.hidden || this.timer !== null || (!this.dirty && !this.buffer.hasPending())) return;
    const epoch = this.epoch;
    this.timer = setTimeout(() => {
      if (epoch !== this.epoch || this.hidden) return;
      this.timer = null;
      const now = performance.now();
      const change = this.buffer.advance(now - this.advancedAt);
      this.advancedAt = now;
      if (this.dirty || change.shouldRender) this.publish(change.items, true);
      this.dirty = false;
      this.schedule();
    }, DISPLAY_INTERVAL_MS);
  }
}
