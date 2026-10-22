/** 浏览器解析现有曲线；只提供时钟，不持有 RAF 或改写滚动。 */
export class FollowMotionClock {
  private readonly timing: Animation;
  private readonly duration: number;
  private startedAt: number | null = null;
  private progress = 0;

  constructor(list: HTMLElement) {
    const style = getComputedStyle(list);
    const value = style.getPropertyValue("--pwa-duration-message-in").trim();
    const number = Number.parseFloat(value);
    this.duration = Number.isFinite(number) ? number * (value.endsWith("ms") ? 1 : 1000) : 0;
    this.timing = new Animation(new KeyframeEffect(null, [], {
      duration: this.duration, easing: style.getPropertyValue("--pwa-ease-standard").trim() || "linear", fill: "both",
    }));
    this.timing.currentTime = 0;
  }

  sample(now: number) {
    this.startedAt ??= now;
    const elapsed = Math.max(0, now - this.startedAt);
    this.timing.currentTime = Math.min(elapsed, this.duration);
    const progress = Math.max(this.progress, this.timing.effect!.getComputedTiming().progress ?? 1);
    // 目标在同一时刻更新时不跳到新路径；只消费剩余时间，不重新开始时钟。
    const fraction = this.progress < 1 ? (progress - this.progress) / (1 - this.progress) : 1;
    this.progress = progress;
    return { progress, fraction, finished: elapsed >= this.duration };
  }

  cancel() { this.timing.cancel(); }
}

/** Working 的局部滚动交接；不拥有输入框，不用于正文增量或普通回执。 */
export class ActivityFollowTransition {
  readonly list: HTMLDivElement;
  private readonly clock: FollowMotionClock;
  private readonly paddingStyle: string;
  private readonly padding: number;
  private extraPadding = 0;
  private top: number;

  constructor(list: HTMLDivElement, fromTop: number) {
    this.list = list;
    this.clock = new FollowMotionClock(list);
    this.paddingStyle = list.style.paddingBottom;
    this.padding = Number.parseFloat(getComputedStyle(list).paddingBottom) || 0;
    this.top = fromTop;
    this.keepReachable();
  }

  private keepReachable() {
    const naturalBottom = Math.max(0, this.list.scrollHeight - this.list.clientHeight - this.extraPadding);
    // 状态移除可能先钳制 scrollTop；仅在交接期间保留尚未收回的空间，结束必定还原。
    this.extraPadding = Math.max(0, this.top - naturalBottom);
    this.list.style.paddingBottom = this.extraPadding > 0 ? `${this.padding + this.extraPadding}px` : this.paddingStyle;
    return naturalBottom;
  }

  advance(now: number): { top: number; finished: boolean } {
    const step = this.clock.sample(now);
    const target = this.keepReachable();
    this.top += (target - this.top) * step.fraction;
    this.keepReachable();
    return { top: this.top, finished: step.finished };
  }

  finish() {
    this.clock.cancel();
    this.list.style.paddingBottom = this.paddingStyle;
  }
}
