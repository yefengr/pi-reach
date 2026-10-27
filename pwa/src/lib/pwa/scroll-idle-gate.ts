/** 最后一次 scroll 之后多久算静止：覆盖 iOS 惯性与回弹逐帧派发 scroll 的间隔。 */
export const SCROLL_IDLE_MS = 200;

export interface ScrollIdleClock {
  now(): number;
  setTimeout(run: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/**
 * 记录触摸与滚动活动，把会改动滚动几何的工作推迟到手势、惯性与回弹结束后执行。
 * iOS 在这些阶段由系统滚动线程持有位置，期间写入的 scrollTop 会被覆盖，或与手势逐帧来回争夺（录屏中的重影）。
 * 不引用 DOM；只保留最近一次请求。
 */
export class ScrollIdleGate {
  private touching = false;
  private lastScroll = Number.NEGATIVE_INFINITY;
  private pending: (() => void) | null = null;
  private timer: number | null = null;

  constructor(private readonly clock: ScrollIdleClock) {}

  touch(active: boolean): void {
    this.touching = active;
    if (!active) this.check();
  }

  /** 只记时间；等待中的定时器到期后按最新时间重新判断。 */
  scrolled(): void {
    this.lastScroll = this.clock.now();
  }

  /** 已静止时同步执行；返回的取消函数只撤销这一次请求。 */
  defer(run: () => void): () => void {
    this.clear();
    this.pending = run;
    this.check();
    return () => { if (this.pending === run) this.clear(); };
  }

  dispose(): void {
    this.clear();
    this.touching = false;
  }

  private clear(): void {
    this.pending = null;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private check(): void {
    if (!this.pending) return;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    // 手指仍按着时不计时，抬起由 touch(false) 重新判断。
    if (this.touching) return;
    const wait = this.lastScroll + SCROLL_IDLE_MS - this.clock.now();
    if (wait > 0) {
      this.timer = this.clock.setTimeout(() => { this.timer = null; this.check(); }, wait);
      return;
    }
    const run = this.pending;
    this.pending = null;
    run();
  }
}
