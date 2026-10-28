import { FollowGlide, TRANSITION_GLIDE_OMEGA } from "./timeline-follow-glide";

export const VIEWPORT_REASONS = ["commit", "geometry", "activity", "resize", "viewport-resize", "hidden", "reduce", "output", "frame", "send", "latest", "input", "user", "details", "reset", "bind", "settle", "scroll"] as const;
export type ViewportReason = typeof VIEWPORT_REASONS[number];
export const VIEWPORT_MODES = ["idle", "follow", "send", "activity", "latest"] as const;
export type ViewportMode = typeof VIEWPORT_MODES[number];
/** tailReply：末尾内容行是 Pi 回复时为其行身份与是否仍在流式输出；正式版本接管后行身份不变。 */
export type ViewportGeometry = { top: number; bottom: number; height: number; animate: boolean; tailSpace: number; compensation: number; tailReply: { row: string; streaming: boolean } | null };
/**
 * target：本帧的滚动目标；提供时滚动由协调器平滑追赶，目标中途变化不在末段一次补完。
 * shift：布局补偿（如顶部 padding 变化）对当前位置的整体平移。
 */
export type ViewportMotionStep = { top: number; finished: boolean; target?: number; shift?: number };
export type ViewportMotion = { advance(now: number): ViewportMotionStep; finish(settleInput?: boolean): void };
export type ViewportCapture<C> = Readonly<{ generation: number; binding: object; value: C }>;
export type ViewportPosition<A> = { following: true } | { following: false; anchor: A };
export interface ViewportLayout<C, A> {
  measure(): ViewportGeometry;
  top(): number;
  scroll(top: number, smooth: boolean): void;
  captureSend(): C | null;
  send(capture: C): ViewportMotion;
  activity(from: number, target: (geometry: ViewportGeometry) => number): ViewportMotion;
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
/** iOS 回弹或惯性收尾期间，前插后恢复的位置会被系统滚动线程覆盖回顶部；此窗口内无新输入的偏移按覆盖处理。 */
const PREPEND_GUARD_MS = 1000;
/** Latest 距离超过该屏数时先瞬时靠近，只平滑最后一屏，避免长距离平滑滚动连续多帧来不及绘制。 */
const LATEST_SMOOTH_SCREENS = 2;
/** 跟随中 Pi 回复增长不超过该屏数时逐帧平滑接续，更大的跳变（如整段补齐）仍瞬时贴底。 */
const FOLLOW_GLIDE_SCREENS = 1;
/** 任何输入后暂停逐帧跟随的时长，与滚动静止判定一致；期间用户滚动会顺延，避免与惯性争夺位置。 */
const FOLLOW_INPUT_HOLD_MS = 200;

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
  /** 上次测量的可视高度；输入区或窗口改变可视高度时的贴底不平滑。 */
  private lastViewport = 0;
  /** 上次测量时仍在流式输出的末尾回复行；同一行被正式版本接管后仍按实时回复接续。 */
  private liveReplyRow: string | null = null;
  /** 跟随 Pi 回复增长的逐帧运动；任何输入、退出或非回复增长都会结束。 */
  private glide: FollowGlide | null = null;
  /** 运动过程报告目标时的滚动追赶；过程结束且到达目标后才交接。 */
  private motionGlide: FollowGlide | null = null;
  private inputHoldUntil = 0;
  private tailCredit = 0;
  private ready = false;
  private handoff = false;
  private activityPending = false;
  private processing = false;
  private exiting = false;
  private pendingReasons = new Set<ViewportReason>();
  /** 已请求更早记录、等待前插实际移动阅读位置。 */
  private prependPending = false;
  private prependGuard: { anchor: A; until: number } | null = null;

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
    this.tailCredit = 0;
    this.clearPrepend();
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
    this.tailCredit = 0;
    this.clearPrepend();
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
    this.tailCredit = 0;
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
    // 即时 Latest 没有后继动画帧，完成后必须能直接处理下一次状态几何。
    this.ready = !geometry.animate;
    if (geometry.animate) this.approachLatest(layout, geometry);
    this.write(geometry.height, geometry.animate, geometry);
    this.record("latest", geometry, geometry.height);
    if (geometry.animate) this.schedule();
  }

  /** 视口高度由已测量的滚动范围推得，不额外读取布局；瞬时写入期间的同步 scroll 不能被当作用户回看。 */
  private approachLatest(layout: ViewportLayout<C, A>, geometry: ViewportGeometry): void {
    const viewport = geometry.height - geometry.bottom;
    if (viewport <= 0 || geometry.bottom - geometry.top <= viewport * LATEST_SMOOTH_SCREENS) return;
    const exiting = this.exiting;
    this.exiting = true;
    try { layout.scroll(geometry.bottom - viewport, false); }
    finally { this.exiting = exiting; }
  }

  /** 请求更早记录：先按回看保存锚点，前插真正移动位置后再开启短期保护。 */
  historyPrepend(): void {
    // 内容不足一屏时的补页：读者看到的就是全部内容，继续跟随最新，前插后仍贴底。
    if (this.following && !this.paused && this.layout && this.layout.measure().bottom <= EPSILON) return;
    this.userRead(true);
    this.prependGuard = null;
    this.prependPending = true;
  }

  /** 新的触摸、滚轮、按键或指针输入表示用户接管位置，前插保护随即失效。 */
  engage(): void {
    this.prependGuard = null;
    this.glide = null;
    this.inputHoldUntil = this.scheduler.now() + FOLLOW_INPUT_HOLD_MS;
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
    if (this.motion || this.mode === "latest" || this.handoff || this.glide) this.userRead();
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
    // 非程序写入的滚动：输入暂停期内的惯性或拖动继续顺延，不恢复逐帧跟随。
    if (this.scheduler.now() < this.inputHoldUntil) this.inputHoldUntil = this.scheduler.now() + FOLLOW_INPUT_HOLD_MS;
    if (this.reassertPrepend(layout, current)) return;
    // MessageList 的 nearBottom 只描述物理底部；借过留白的有效目标可能远于 32px。
    if (this.tailCredit > 0 && this.following && !this.paused && !this.motion) {
      const geometry = layout.measure();
      const target = this.followTarget(geometry);
      const bottom = this.naturalBottom(geometry);
      if (current >= target - EPSILON && current <= bottom + EPSILON) {
        // 向下使用剩余留白不是回看；把实际位置作为后续目标，不能拉回旧落点。
        this.tailCredit = Math.min(this.tailCredit, Math.max(0, bottom - current));
        this.lastTop = current;
        return;
      }
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

  /** 保护期内无新输入却偏离前插锚点，视为系统覆盖了恢复结果：同步恢复，后续顶部判断读取的是恢复后的位置。 */
  private reassertPrepend(layout: ViewportLayout<C, A>, current: number): boolean {
    const guard = this.prependGuard;
    if (!guard) return false;
    if ((this.following && !this.paused) || this.scheduler.now() > guard.until || !this.restoreAnchor(layout, guard.anchor)) {
      this.prependGuard = null;
      return false;
    }
    if (Math.abs(layout.top() - current) <= EPSILON) return false;
    this.anchor = guard.anchor;
    return true;
  }

  private clearPrepend(): void {
    this.prependPending = false;
    this.prependGuard = null;
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
    this.motionGlide = null;
    this.motionTime = null;
    this.receipt = null;
    this.glide = null;
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
    this.receipt = { target: geometry ? Math.min(top, geometry.bottom) : top, last: layout.top(), smooth };
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

  private naturalBottom(geometry: ViewportGeometry): number {
    return Math.max(0, geometry.bottom - geometry.compensation);
  }

  private followTarget(geometry: ViewportGeometry): number {
    // Thinking/工具转正文不一定再发 Working 显隐通知。净收缩先归还借用量，不能把旧正文往下拉。
    this.tailCredit = Math.min(this.tailCredit, geometry.tailSpace, Math.max(0, this.naturalBottom(geometry) - this.lastTop));
    return this.naturalBottom(geometry) - this.tailCredit;
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
      const before = layout.top();
      if (this.anchor && !this.restoreAnchor(layout, this.anchor)) this.anchor = null;
      else if (this.anchor && this.prependPending && Math.abs(layout.top() - before) > EPSILON) {
        this.prependPending = false;
        this.prependGuard = { anchor: this.anchor, until: this.scheduler.now() + PREPEND_GUARD_MS };
      }
      this.anchor ??= layout.captureAnchor();
      this.lastTop = layout.top();
      if (this.trace && this.tracing()) this.record(reason, layout.measure(), null);
      return;
    }
    let geometry = layout.measure();
    this.lastBottom = geometry.bottom;
    const viewportChanged = Math.abs(geometry.height - geometry.bottom - this.lastViewport) > EPSILON;
    this.lastViewport = geometry.height - geometry.bottom;
    // 只有实时回复（流式中或刚由同一行交接）平滑；历史加载与直接到达的正式回复仍瞬时。
    const tail = geometry.tailReply;
    const liveReply = tail !== null && (tail.streaming || tail.row === this.liveReplyRow);
    this.liveReplyRow = liveReply ? tail.row : null;
    if (this.mode === "latest") {
      const target = Math.min(this.receipt?.target ?? geometry.bottom, geometry.bottom);
      if (geometry.animate && Math.abs(geometry.top - target) > EPSILON) { this.schedule(); return; }
      if (!geometry.animate) { this.exit(false); geometry = layout.measure(); }
      else { this.receipt = null; this.mode = "follow"; }
    }
    if (this.activityPending) {
      this.activityPending = false;
      if (this.ready && this.mode !== "send" && this.mode !== "latest") {
        const bottom = this.naturalBottom(geometry);
        const target = Math.min(bottom, Math.max(0, this.lastTop, bottom - geometry.tailSpace));
        this.tailCredit = bottom - target;
        if (!this.motion && geometry.animate && Math.abs(target - this.lastTop) > EPSILON) {
          this.motion = layout.activity(this.lastTop, (value) => this.followTarget(value));
          this.mode = "activity";
        }
      }
    }
    let requested: number | null = null;
    if (this.motion) {
      if (!geometry.animate) { this.exit(false); geometry = layout.measure(); }
      else {
        const epoch = this.frameEpoch;
        const time = this.sampleMotionTime(frameTime);
        const step = this.motion.advance(time);
        if (epoch !== this.frameEpoch || this.layout !== layout) return;
        const tracked = this.trackMotion(step, time);
        if (!step.finished || !tracked.settled) {
          requested = tracked.top;
          this.write(tracked.top, false);
          this.schedule();
          this.record(reason, geometry, requested);
          return;
        }
        this.exit(false);
        geometry = layout.measure();
        this.handoff = true;
        requested = this.followTarget(geometry);
        this.write(requested, false, geometry);
        this.schedule();
        this.record(reason, geometry, requested);
        return;
      }
    }
    this.mode = "follow";
    const target = this.followTarget(geometry);
    const distance = target - geometry.top;
    const glide = this.handoff || viewportChanged || !liveReply ? null : this.glideMode(geometry, distance);
    if (glide === "hold") {
      // 输入暂停期不写入滚动，逐帧等待暂停结束后从静止重新跟随。
      this.lastTop = geometry.top;
      this.schedule();
    } else if (glide === "glide") {
      requested = target;
      this.advanceGlide(geometry, target, frameTime);
    } else if (this.handoff || Math.abs(distance) > EPSILON) {
      this.glide = null;
      this.handoff = false;
      requested = this.tailCredit === 0 ? geometry.height : target;
      this.write(requested, false, geometry);
    } else {
      this.glide = null;
      this.lastTop = geometry.top;
    }
    this.ready = true;
    this.record(reason, geometry, requested);
  }

  /** 过程报告目标时以阻尼运动追赶，否则直接采用过程给出的位置。 */
  private trackMotion(step: ViewportMotionStep, time: number): { top: number; settled: boolean } {
    if (step.target === undefined) return { top: step.top, settled: true };
    if (!this.motionGlide) this.motionGlide = new FollowGlide(step.top, TRANSITION_GLIDE_OMEGA);
    else if (step.shift) this.motionGlide.shift(step.shift);
    return this.motionGlide.advance(time, step.target);
  }

  /**
   * 已稳定跟随时，实时 Pi 回复向下增长的小段位移逐帧平滑接续，输入暂停期内保持不动；
   * 其他新行、回执、首次贴底、回缩与可视高度变化仍瞬时。
   */
  private glideMode(geometry: ViewportGeometry, distance: number): "glide" | "hold" | null {
    const viewport = geometry.height - geometry.bottom;
    if (!geometry.animate || !this.ready || viewport <= 0 || distance > viewport * FOLLOW_GLIDE_SCREENS) return null;
    if (this.glide ? distance < -EPSILON : distance <= EPSILON) return null;
    return this.scheduler.now() < this.inputHoldUntil ? "hold" : "glide";
  }

  /** 同步布局只更新目标并预约下一帧；位移只在动画帧按真实时间推进。 */
  private advanceGlide(geometry: ViewportGeometry, target: number, frameTime?: number): void {
    this.glide ??= new FollowGlide(geometry.top);
    if (frameTime === undefined) {
      this.schedule();
      return;
    }
    const step = this.glide.advance(frameTime, target);
    this.write(step.top, false, geometry);
    if (step.settled) this.glide = null;
    else this.schedule();
  }

  private record(reason: ViewportReason, geometry: ViewportGeometry, requested: number | null): void {
    if (this.tracing()) this.trace?.({ ...this.state, reason, top: geometry.top, bottom: geometry.bottom, requested, actual: this.lastTop });
  }
}
