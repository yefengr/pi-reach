import { pwaStandardEasing } from "@/lib/ui/motion";
import { readPwaMotionDuration } from "@/lib/ui/motion-duration";

/** 浏览器解析现有曲线；只提供时钟，不持有 RAF 或改写滚动。 */
export class FollowMotionClock {
  private readonly timing: Animation;
  private readonly duration: number;
  private startedAt: number | null = null;
  private progress = 0;

  constructor(list: HTMLElement) {
    this.duration = readPwaMotionDuration("--pwa-duration-message-in");
    this.timing = new Animation(new KeyframeEffect(null, [], { duration: this.duration, easing: pwaStandardEasing(list), fill: "both" }));
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

const activityOwners = new WeakMap<HTMLDivElement, ActivityFollowTransition>();
const MINIMUM_TAIL_SPACE = 8;

/** 临时可达空间不属于自然留白；预算切换时也不能把补偿借给下一次布局。 */
export function activityFollowSpace(list: HTMLDivElement): { tailSpace: number; compensation: number } {
  const owner = activityOwners.get(list);
  const applied = Number.parseFloat(getComputedStyle(list).paddingBottom) || 0;
  const padding = owner ? owner.naturalPadding() : applied;
  // 自然预算增长时差值可以为负；仍以当前 CSS 目标还原自然滚动范围。
  return { tailSpace: Math.max(0, padding - MINIMUM_TAIL_SPACE), compensation: owner ? applied - padding : 0 };
}

/** Working 的局部滚动交接；不拥有输入框，不用于正文增量或普通回执。 */
export class ActivityFollowTransition {
  readonly list: HTMLDivElement;
  private readonly clock: FollowMotionClock;
  private readonly paddingStyle: string;
  private top: number;

  constructor(list: HTMLDivElement, fromTop: number, private readonly target: () => number) {
    this.list = list;
    this.clock = new FollowMotionClock(list);
    this.paddingStyle = list.style.paddingBottom;
    this.top = fromTop;
    activityOwners.set(list, this);
    this.keepReachable();
  }

  naturalPadding(): number {
    // 生产 CSS 的滚动避让与自然尾部留白同值，且不受临时 inline padding 覆盖。
    // 密度与 Composer 预算分支均须保持此约束；测量不改写布局或滚动位置。
    return Number.parseFloat(getComputedStyle(this.list).scrollPaddingBottom) || 0;
  }

  private keepReachable() {
    const padding = this.naturalPadding();
    const applied = Number.parseFloat(getComputedStyle(this.list).paddingBottom) || 0;
    const naturalBottom = Math.max(0, this.list.scrollHeight - this.list.clientHeight - applied + padding);
    // 状态移除可能先钳制 scrollTop；仅在交接期间保留尚未收回的空间，结束必定还原。
    // 补偿取整数：scrollHeight 已取整，小数补偿相减会把自然底部低估不到 1px，收尾时出现 1px 回退。
    const extraPadding = Math.max(0, Math.ceil(this.top - naturalBottom));
    this.list.style.paddingBottom = extraPadding > 0 ? `${padding + extraPadding}px` : this.paddingStyle;
  }

  advance(now: number): { top: number; finished: boolean } {
    const step = this.clock.sample(now);
    this.keepReachable();
    const target = this.target();
    this.top += (target - this.top) * step.fraction;
    this.keepReachable();
    return { top: this.top, finished: step.finished };
  }

  finish() {
    this.clock.cancel();
    activityOwners.delete(this.list);
    this.list.style.paddingBottom = this.paddingStyle;
  }
}
