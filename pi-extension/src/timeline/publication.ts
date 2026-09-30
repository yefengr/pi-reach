import type { TimelineEvent } from "../protocol/v2/index.js";
import type { Correlation } from "./runtime.js";

/** 待持久化的 marker 只在正式事件可恢复后发布；SDK 轮次边界负责完成剩余发布。 */
export class TimelinePublications {
  private revision = 0;
  private readonly pending = new Map<string, Correlation>();
  private readonly published: TimelineEvent[] = [];

  constructor(private readonly onPublished: (event: TimelineEvent, correlation: Correlation) => void) {}

  reset(): void {
    this.revision += 1;
    this.pending.clear();
    this.published.length = 0;
  }

  events(): readonly TimelineEvent[] {
    return [...this.published];
  }

  publish(event: TimelineEvent, correlation: Correlation): void {
    if (this.published.some((existing) => existing.event_id === event.event_id)) return;
    this.published.push(event);
    this.onPublished(event, { ...correlation });
  }

  defer(markerId: string, correlation: Correlation, recover: () => readonly TimelineEvent[], markerVisible: () => boolean): void {
    this.pending.set(markerId, { ...correlation });
    const revision = this.revision;
    setImmediate(() => {
      if (revision !== this.revision) return;
      if (!markerVisible()) { this.pending.delete(markerId); return; }
      this.flush(recover);
    });
  }

  flush(recover: () => readonly TimelineEvent[]): void {
    if (this.pending.size === 0) return;
    // recover 已按持久化位置编号；一起发布可见事件，避免较晚事件越过待发布的正式记录。
    for (const event of recover()) {
      const correlation = this.pending.get(event.event_id);
      if (!correlation) continue;
      this.pending.delete(event.event_id);
      this.publish(event, correlation);
    }
  }
}
