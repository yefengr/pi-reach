import type { TimelineEvent } from "../pi-reach/protocol-v2/schema";
import { TIMELINE_PAGE_SIZE } from "./timeline-history-loader";

/** 时间线向前翻页的来源：在线会话经 Relay 补齐（TimelineHistoryLoader），只读历史读本地（TimelineLocalPager）。 */
export interface TimelineEarlierSource {
  readonly hasEarlier: boolean;
  loadEarlier(): Promise<boolean>;
  dispose(): void;
}

export type TimelineLocalPagerOptions = {
  /** 本地保存的全部正式记录，按显示顺序排列。 */
  events: readonly TimelineEvent[];
  /** 已显示的末尾记录条数。 */
  shown: number;
  onPage: (events: TimelineEvent[]) => void;
  onState: (state: { hasEarlier: boolean; loading: boolean }) => void;
};

/**
 * 只读历史的向前分页。记录已整体读入内存，按条数而不是序号区间翻页：本地缺口再大也不会出现空页，
 * 也不请求 Relay、不写回本地。回调时序与 TimelineHistoryLoader 一致：先 loading，页到达后再结束。
 */
export class TimelineLocalPager implements TimelineEarlierSource {
  private shown: number;
  private loading = false;
  private disposed = false;

  constructor(private readonly options: TimelineLocalPagerOptions) {
    this.shown = Math.max(0, Math.min(Math.floor(options.shown), options.events.length));
    this.emitState(false);
  }

  get hasEarlier(): boolean {
    return this.shown < this.options.events.length;
  }

  /** 已显示的条数；离开时保存，切回后按它展开到同一位置。 */
  get shownCount(): number {
    return this.shown;
  }

  /** 首屏显示的末尾记录。 */
  initialEvents(): TimelineEvent[] {
    return this.shown === 0 ? [] : this.options.events.slice(-this.shown);
  }

  loadEarlier(): Promise<boolean> {
    if (this.disposed || this.loading || !this.hasEarlier) return Promise.resolve(false);
    this.loading = true;
    this.emitState(true);
    // 与 Relay 分页一样异步交付，调用方在发起后、页到达前完成的状态登记不受影响。
    return Promise.resolve().then(() => {
      this.loading = false;
      if (this.disposed) return false;
      const end = this.options.events.length - this.shown;
      const start = Math.max(0, end - TIMELINE_PAGE_SIZE);
      this.shown += end - start;
      this.options.onPage(this.options.events.slice(start, end));
      this.emitState(false);
      return true;
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  private emitState(loading: boolean): void {
    if (!this.disposed) this.options.onState({ hasEarlier: this.hasEarlier, loading });
  }
}
