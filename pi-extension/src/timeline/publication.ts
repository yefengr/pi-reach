import type { TimelineEvent } from "../protocol/v2/index.js";
import type { Correlation } from "./runtime.js";

type PendingPublication = {
  correlation: Correlation;
  markerVisible: () => boolean;
};

type ScheduledDrain = {
  readonly revision: number;
  recover: () => readonly TimelineEvent[];
  immediate?: ReturnType<typeof setImmediate>;
};

/** 待持久化的 marker 只在正式事件可恢复后发布；SDK 轮次边界负责完成剩余发布。 */
export class TimelinePublications {
  private revision = 0;
  private readonly pending = new Map<string, PendingPublication>();
  private readonly published: TimelineEvent[] = [];
  /** 同一批次只保留一个已登记宏任务；重复 defer 复用该批次，恢复次数不随登记次数增长。 */
  private scheduled: ScheduledDrain | null = null;

  constructor(private readonly onPublished: (event: TimelineEvent, correlation: Correlation) => void) {}

  reset(): void {
    this.revision += 1;
    this.pending.clear();
    this.published.length = 0;
    this.cancelScheduled();
  }

  events(): readonly TimelineEvent[] {
    return [...this.published];
  }

  publish(event: TimelineEvent, correlation: Correlation): void {
    if (this.published.some((existing) => existing.event_id === event.event_id)) return;
    this.pending.delete(event.event_id);
    this.published.push(event);
    this.onPublished(event, { ...correlation });
  }

  defer(markerId: string, correlation: Correlation, recover: () => readonly TimelineEvent[], markerVisible: () => boolean): void {
    // 已发布项无需再次登记或恢复。
    if (this.published.some((event) => event.event_id === markerId)) return;
    this.pending.set(markerId, { correlation: { ...correlation }, markerVisible });
    this.scheduleDrain(recover);
  }

  /** 显式边界：取消同批宏任务并立即恢复一次，避免无进展时又跑同一次恢复。 */
  flush(recover: () => readonly TimelineEvent[]): void {
    this.cancelScheduled();
    this.drain(recover);
  }

  private scheduleDrain(recover: () => readonly TimelineEvent[]): void {
    if (this.scheduled) {
      this.scheduled.recover = recover;
      return;
    }
    const scheduled: ScheduledDrain = { revision: this.revision, recover };
    scheduled.immediate = setImmediate(() => {
      // reset 或显式 flush 之后旧回调不得清掉新批次，也不得发布旧数据。
      if (this.scheduled !== scheduled) return;
      this.scheduled = null;
      if (scheduled.revision !== this.revision) return;
      this.drain(scheduled.recover);
    });
    this.scheduled = scheduled;
  }

  private cancelScheduled(): void {
    const scheduled = this.scheduled;
    if (!scheduled) return;
    this.scheduled = null;
    if (scheduled.immediate !== undefined) clearImmediate(scheduled.immediate);
  }

  private drain(recover: () => readonly TimelineEvent[]): void {
    if (this.pending.size === 0) return;
    // 每项独立核对分支可见性：单个 marker 失效不得连带丢弃同批其他有效项，也不得发出已离开分支的事件。
    let visible = 0;
    for (const [markerId, entry] of this.pending) {
      if (!entry.markerVisible()) {
        this.pending.delete(markerId);
        continue;
      }
      visible += 1;
    }
    if (visible === 0) return;
    // recover 已按持久化位置编号；一起发布可见事件，避免较晚事件越过待发布的正式记录。
    for (const event of recover()) {
      const entry = this.pending.get(event.event_id);
      if (!entry) continue;
      this.pending.delete(event.event_id);
      this.publish(event, entry.correlation);
    }
  }
}
