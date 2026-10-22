export const VIEWPORT_REASONS = ["commit", "geometry", "activity", "resize", "viewport-resize", "hidden", "reduce", "output", "frame", "send", "latest", "input", "user", "details", "reset", "bind", "settle", "scroll"] as const;
export type ViewportReason = typeof VIEWPORT_REASONS[number];
export const VIEWPORT_MODES = ["idle", "follow", "send", "activity", "latest"] as const;
export type ViewportMode = typeof VIEWPORT_MODES[number];
export type ViewportGeometry = { top: number; bottom: number; height: number; animate: boolean };
export type ViewportMotion = { advance(now: number): { top: number; finished: boolean }; finish(settleInput?: boolean): void };
export type ViewportCapture<C> = Readonly<{ generation: number; binding: object; value: C }>;
export type ViewportPosition<A> = { following: true } | { following: false; anchor: A };
export interface ViewportLayout<C, A> {
  measure(): ViewportGeometry;
  top(): number;
  scroll(top: number, smooth: boolean): void;
  captureSend(): C | null;
  send(capture: C): ViewportMotion;
  activity(from: number): ViewportMotion;
  captureAnchor(fallback?: boolean): A | null;
  restoreAnchor(anchor: A, migrate?: boolean): boolean;
}
export interface ViewportScheduler {
  now(): number;
  request(callback: (now: number) => void): number;
  cancel(frame: number): void;
}
export type ViewportState = Readonly<{ following: boolean; unread: number; paused: boolean; mode: ViewportMode; generation: number }>;
export type ViewportTrace = ViewportState & { reason: ViewportReason; top: number; bottom: number; requested: number | null; actual: number };
const EPSILON = 1;

/** 不引用 DOM：所有过程的退出、布局释放和后继推进都在这里决定。 */
export class TimelineViewportCoordinator<C, A> {
  private layout: ViewportLayout<C, A> | null = null;
  private generation = 0;
  private following = true;
  private paused = false;
  private mode: ViewportMode = "idle";
  private motion: ViewportMotion | null = null;
  private motionTime: number | null = null;
  private frame: number | null = null;
  private frameEpoch = 0;
  private anchor: A | null = null;
  private pendingAnchor: A | null = null;
  private unread = new Set<string>();
  private receipt: { target: number; last: number; smooth: boolean } | null = null;
  private lastTop = 0;
  private lastBottom = 0;
  private ready = false;
  private handoff = false;
  private activityPending = false;
  private processing = false;
  private exiting = false;
  private pendingReasons = new Set<ViewportReason>();

  constructor(private readonly scheduler: ViewportScheduler, private readonly changed: (state: ViewportState) => void,
    private trace?: (entry: ViewportTrace) => void, private tracing: () => boolean = () => true) {}

  setDiagnostics(trace: (entry: ViewportTrace) => void, enabled: () => boolean): void {
    this.trace = trace;
    this.tracing = enabled;
  }

  get state(): ViewportState {
    return { following: this.following, unread: this.unread.size, paused: this.paused, mode: this.mode, generation: this.generation };
  }

  bind(layout: ViewportLayout<C, A> | null): void {
    if (layout === this.layout) return;
    this.exit(false);
    this.generation += 1;
    this.layout = layout;
    this.anchor = null;
    this.ready = false;
    this.lastTop = layout?.top() ?? 0;
    this.lastBottom = 0;
    this.publish("bind");
  }

  reset(): void {
    this.pendingAnchor = null;
    this.resumeFollowing("reset");
  }

  /** 到底只恢复阅读意图；迟到历史的 scope 锚点须等目标行真正到达。 */
  private resumeFollowing(reason: "reset" | "scroll"): void {
    this.exit(false);
    this.generation += 1;
    this.following = true;
    this.paused = false;
    this.anchor = null;
    this.unread.clear();
    this.ready = false;
    this.lastTop = this.layout?.top() ?? 0;
    this.publish(reason);
  }

  captureOwnSend(): ViewportCapture<C> | null {
    const value = this.layout?.captureSend();
    return value == null || !this.layout ? null : Object.freeze({ generation: this.generation, binding: this.layout, value });
  }

  followOwnSend(capture: ViewportCapture<C> | null): void {
    if (!capture || capture.binding !== this.layout || capture.generation !== this.generation || !this.layout) return;
    // 连续成功发送从捕获的可见尺寸接续，不先写上一次输入的终点。
    this.exit(false, false);
    this.generation += 1;
    this.following = true;
    this.paused = false;
    this.pendingAnchor = null;
    this.anchor = null;
    this.unread.clear();
    this.motion = this.layout.measure().animate ? this.layout.send(capture.value) : null;
    this.mode = this.motion ? "send" : "follow";
    this.publish("send");
    // owner 立即固定捕获尺寸；首个已提交布局（或无提交时的后继帧）才消费动画时间。
    if (this.motion) this.schedule();
    else this.process("send");
  }

  latest(): void {
    this.reset();
    const layout = this.layout;
    if (!layout) return;
    const geometry = layout.measure();
    this.lastBottom = geometry.bottom;
    this.mode = geometry.animate ? "latest" : "follow";
    this.write(geometry.height, geometry.animate, geometry);
    this.record("latest", geometry, geometry.height);
    if (geometry.animate) this.schedule();
  }

  details(reading: boolean): void {
    if (reading === this.paused) return;
    this.exit(true);
    this.paused = reading;
    this.anchor = this.layout?.captureAnchor() ?? null;
    this.publish("details");
    if (!reading && this.following) this.schedule();
  }

  userRead(fallback = false): void {
    this.exit(true);
    this.pendingAnchor = null;
    if (this.following) this.unread.clear();
    this.following = false;
    this.anchor = this.layout?.captureAnchor(fallback) ?? null;
    this.lastTop = this.layout?.top() ?? 0;
    this.publish("user");
  }

  /** 明确输入只打断正在拥有滚动位置的过程；轻点不调用本入口。 */
  interrupt(): void {
    if (this.motion || this.mode === "latest" || this.handoff) this.userRead();
  }

  input(): void {
    if (this.mode !== "send") return;
    this.exit(true);
    this.publish("input");
    if (this.following && !this.paused) this.schedule();
  }

  settle(reason: "settle" | "hidden" | "reduce" | "viewport-resize" = "settle"): void {
    this.exit(!this.following || this.paused);
    this.process(reason);
  }

  output(key: string): void {
    if (!this.following || this.paused) {
      this.unread.add(key);
      this.publish("output");
    } else this.schedule();
  }

  scroll(nearBottom: boolean): void {
    if (this.exiting) return;
    const layout = this.layout;
    if (!layout) return;
    const current = layout.top();
    const receipt = this.receipt;
    if (receipt) {
      const reachable = Math.min(receipt.target, layout.measure().bottom);
      if (Math.abs(current - reachable) <= EPSILON) {
        this.lastTop = current;
        if (receipt.smooth) {
          this.receipt = null;
          this.mode = "follow";
          this.schedule();
        } else if (!this.motion && !this.handoff) this.receipt = null;
        return;
      }
      if (receipt.smooth && current + EPSILON >= receipt.last && current <= receipt.target + EPSILON) {
        receipt.last = current;
        this.lastTop = current;
        return;
      }
      if (!receipt.smooth && (this.motion || this.handoff)) {
        this.write(reachable, false);
        return;
      }
      this.receipt = null;
    }
    this.lastTop = current;
    if (this.paused) {
      this.anchor = layout.captureAnchor();
      if (!nearBottom) { this.pendingAnchor = null; this.following = false; this.publish(); }
      return;
    }
    if (!nearBottom) { this.userRead(); return; }
    this.resumeFollowing("scroll");
    this.ready = true;
  }

  capturePosition(): ViewportPosition<A> | null {
    if (!this.layout) return null;
    if (this.following && !this.paused) return { following: true };
    const anchor = this.layout.captureAnchor();
    return anchor ? { following: false, anchor } : { following: true };
  }

  restorePosition(position: ViewportPosition<A> | null): void {
    this.pendingAnchor = position && !position.following ? position.anchor : null;
  }

  notify(reason: "commit" | "geometry" | "activity" | "resize", hasContent = true): void {
    if (!hasContent) { this.ready = false; return; }
    if (reason === "activity") {
      // 子 layout effect 已处于 DOM mutation 之后；同步保留可达空间并启动唯一时钟。
      this.activityPending = true;
      this.process(reason);
      return;
    }
    if ((reason === "resize" && this.following && !this.paused) || (reason === "geometry" && this.activityPending)) {
      this.schedule();
      return;
    }
    this.process(reason);
  }

  private publish(reason: ViewportReason = "reset"): void {
    this.changed(this.state);
    if (this.tracing()) this.trace?.({ ...this.state, reason, top: this.lastTop, bottom: this.lastBottom, requested: null, actual: this.lastTop });
  }

  private cancelFrame(): void {
    this.frameEpoch += 1;
    if (this.frame !== null) this.scheduler.cancel(this.frame);
    this.frame = null;
  }

  /** 退出策略集中：捕获→取消→释放→恢复→刷新实际基线。 */
  private exit(preserve: boolean, settleInput = true): void {
    if (this.exiting) return;
    const layout = this.layout;
    const anchor = preserve ? layout?.captureAnchor() : null;
    const stopLatest = this.mode === "latest";
    const motion = this.motion;
    this.cancelFrame();
    this.motion = null;
    this.motionTime = null;
    this.receipt = null;
    this.handoff = false;
    this.activityPending = false;
    this.pendingReasons.clear();
    this.mode = "idle";
    this.exiting = true;
    try {
      motion?.finish(settleInput);
      if (anchor && layout) this.restoreAnchor(layout, anchor);
      if (stopLatest && layout) layout.scroll(layout.top(), false);
      this.lastTop = layout?.top() ?? 0;
    } finally { this.exiting = false; }
  }

  private schedule(): void {
    if (!this.layout || this.frame !== null) return;
    const epoch = this.frameEpoch;
    const generation = this.generation;
    this.frame = this.scheduler.request((now) => {
      if (epoch !== this.frameEpoch || generation !== this.generation) return;
      this.frame = null;
      this.process("frame", now);
    });
  }

  private write(top: number, smooth: boolean, geometry?: ViewportGeometry): void {
    const layout = this.layout;
    if (!layout) return;
    this.receipt = { target: geometry?.bottom ?? top, last: layout.top(), smooth };
    layout.scroll(top, smooth);
    const actual = layout.top();
    if (this.layout !== layout || (!this.following || this.paused)) return;
    this.lastTop = actual;
    if (!smooth) this.receipt = { target: actual, last: actual, smooth: false };
  }

  private acceptRestoredTop(layout: ViewportLayout<C, A>): void {
    const actual = layout.top();
    this.lastTop = actual;
    this.receipt = { target: actual, last: actual, smooth: false };
  }

  private restoreAnchor(layout: ViewportLayout<C, A>, anchor: A, migrate = false): boolean {
    // 原生 scroll 异步回执用实际落点；同步适配器重入时也不能先被当作用户回看。
    const exiting = this.exiting;
    this.exiting = true;
    let restored: boolean;
    try { restored = layout.restoreAnchor(anchor, migrate); }
    finally { this.exiting = exiting; }
    if (restored && this.layout === layout) this.acceptRestoredTop(layout);
    return restored;
  }

  /** 同步布局只初始化或复用已采样时间；后续进度由唯一 RAF 提供。 */
  private sampleMotionTime(frameTime?: number): number {
    if (this.motionTime === null) this.motionTime = frameTime ?? this.scheduler.now();
    else if (frameTime !== undefined) this.motionTime = Math.max(this.motionTime, frameTime);
    return this.motionTime;
  }

  private process(reason: ViewportReason, frameTime?: number): void {
    if (this.processing || this.exiting) { this.pendingReasons.add(reason); return; }
    const layout = this.layout;
    if (!layout) return;
    this.processing = true;
    try { this.advance(layout, reason, frameTime); }
    finally {
      this.processing = false;
      // 同步 scroll/geometry 重入只合并后继帧，不递归采样同一时钟。
      if (this.pendingReasons.size) { this.pendingReasons.clear(); this.schedule(); }
    }
  }

  private advance(layout: ViewportLayout<C, A>, reason: ViewportReason, frameTime?: number): void {
    if (this.pendingAnchor) {
      if (this.restoreAnchor(layout, this.pendingAnchor, true)) {
        this.pendingAnchor = null;
        this.userRead();
        this.acceptRestoredTop(layout);
        if (this.trace && this.tracing()) this.record(reason, layout.measure(), null);
        return;
      }
    }
    if (!this.following || this.paused) {
      if (this.anchor && !this.restoreAnchor(layout, this.anchor)) this.anchor = null;
      this.anchor ??= layout.captureAnchor();
      this.lastTop = layout.top();
      if (this.trace && this.tracing()) this.record(reason, layout.measure(), null);
      return;
    }
    let geometry = layout.measure();
    this.lastBottom = geometry.bottom;
    if (this.mode === "latest") {
      const target = Math.min(this.receipt?.target ?? geometry.bottom, geometry.bottom);
      if (geometry.animate && Math.abs(geometry.top - target) > EPSILON) { this.schedule(); return; }
      if (!geometry.animate) { this.exit(false); geometry = layout.measure(); }
      else { this.receipt = null; this.mode = "follow"; }
    }
    if (this.activityPending) {
      this.activityPending = false;
      if (this.ready && !this.motion && geometry.animate && Math.abs(geometry.bottom - this.lastTop) > EPSILON) {
        this.motion = layout.activity(this.lastTop);
        this.mode = "activity";
      }
    }
    let requested: number | null = null;
    if (this.motion) {
      if (!geometry.animate) { this.exit(false); geometry = layout.measure(); }
      else {
        const epoch = this.frameEpoch;
        const step = this.motion.advance(this.sampleMotionTime(frameTime));
        if (epoch !== this.frameEpoch || this.layout !== layout) return;
        if (!step.finished) {
          requested = step.top;
          this.write(step.top, false);
          this.schedule();
          this.record(reason, geometry, requested);
          return;
        }
        this.exit(false);
        geometry = layout.measure();
        this.handoff = true;
        requested = geometry.bottom;
        this.write(geometry.bottom, false, geometry);
        this.schedule();
        this.record(reason, geometry, requested);
        return;
      }
    }
    this.mode = "follow";
    if (this.handoff || geometry.bottom - geometry.top > EPSILON) {
      this.handoff = false;
      requested = geometry.height;
      this.write(geometry.height, false, geometry);
    } else this.lastTop = geometry.top;
    this.ready = true;
    this.record(reason, geometry, requested);
  }

  private record(reason: ViewportReason, geometry: ViewportGeometry, requested: number | null): void {
    if (this.tracing()) this.trace?.({ ...this.state, reason, top: geometry.top, bottom: geometry.bottom, requested, actual: this.lastTop });
  }
}
