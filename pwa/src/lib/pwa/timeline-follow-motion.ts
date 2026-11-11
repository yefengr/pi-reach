import { chatFooterSpace } from "./chat-footer-space";
import { pwaContentEasing } from "@/lib/ui/motion";
import { readPwaMotionDuration } from "@/lib/ui/motion-duration";

/** 浏览器解析现有曲线；只提供时钟，不持有 RAF 或改写滚动。 */
export class FollowMotionClock {
  private readonly timing: Animation;
  private readonly duration: number;
  private startedAt: number | null = null;
  private progress = 0;

  /** duration 缺省为 `message-in`；过程组收起保持传入收起时长，与收起同一时钟。 */
  constructor(list: HTMLElement, duration = readPwaMotionDuration("--pwa-duration-message-in")) {
    this.duration = duration;
    this.timing = new Animation(new KeyframeEffect(null, [], { duration: this.duration, easing: pwaContentEasing(list), fill: "both" }));
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

/** 列表末尾的 1px 哨兵：其位置即内容（不含底部内边距）的结束处。 */
const BOTTOM_SENTINEL_SELECTOR = ".pwa-bottom-sentinel";

/** 过程组收起保持的临时空间：属性开启列表末尾的伪元素，自定义属性给出其高度。 */
const HOLD_ATTRIBUTE = "data-timeline-hold";
const HOLD_PROPERTY = "--pwa-timeline-hold";

/** 当前持有临时可达空间的过渡；测量据此区分自然留白与临时补偿。 */
const activityOwners = new WeakMap<HTMLDivElement, { naturalPadding(): number; heldSpace?(): number }>();
const MINIMUM_TAIL_SPACE = 8;

/** 临时可达空间不属于自然留白；预算切换时也不能把补偿借给下一次布局。 */
export function activityFollowSpace(list: HTMLDivElement): { tailSpace: number; compensation: number } {
  const owner = activityOwners.get(list);
  const applied = Number.parseFloat(getComputedStyle(list).paddingBottom) || 0;
  const padding = owner ? owner.naturalPadding() : applied;
  // 底部留白包含浮动输入区的高度，那部分被输入区盖住，不能用来容纳内容增长。
  const footer = chatFooterSpace(list);
  // 自然预算增长时差值可以为负；仍以当前 CSS 目标还原自然滚动范围。
  return { tailSpace: Math.max(0, padding - footer - MINIMUM_TAIL_SPACE), compensation: owner ? applied - padding + (owner.heldSpace?.() ?? 0) : 0 };
}

/** Working 显隐的局部滚动交接；不拥有输入框，不用于正文增量或普通回执。 */
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
    const extraPadding = Math.ceil(this.top - naturalBottom);
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

/**
 * 过程组收起时组头原位不动：开始收起即保留全部待收回高度，滚动位置保持不变，上方内容不随收起下移。
 * 临时空间由列表末尾的伪元素承担（`data-timeline-hold` 与 `--pwa-timeline-hold`），不加在底部内边距上：
 * 滚动容器的盒高不能小于自身内边距，保留量超过可视高度时会把列表撑高、滚动范围随之失真。
 * - 收起时钟结束后进入保持：临时空间随后续内容填入逐步减少，内容填满（自然底部到达保持位置）即结束。
 * - release：没有后续内容可填（本轮已结束或空闲时收起）时，收起结束后以同一时长与曲线平滑移到 target 再释放空间；
 *   收起尚未结束时调用会等收起结束再开始。
 * - lift：组头已在可见区上方时（组比一屏高），原位不动会让收起后屏幕只剩空白。收起期间以实际收起时长与同一曲线
 *   把位置上移 lift，组头随收拢滑回可见区；只保留其余高度作为空白。用户接管后停止带回。
 */
export type CollapseLift = Readonly<{ distance: number; duration: number }>;

export class CollapseHoldTransition {
  readonly list: HTMLDivElement;
  private duration: number;
  private clock: FollowMotionClock;
  private phase: "collapse" | "hold" | "release" = "collapse";
  private released = false;
  private top: number;
  /** 当前保留的临时空间；收起结束后只减不增。 */
  private extra = 0;
  /** 收起期间带回组头的终点与时钟；没有带回或已被用户接管时为 null。 */
  private lift: { target: number; clock: FollowMotionClock } | null = null;

  constructor(list: HTMLDivElement, from: number, private readonly target: () => number, duration: number, private reserve: number, lift?: CollapseLift) {
    this.list = list;
    this.duration = duration;
    this.clock = new FollowMotionClock(list, duration);
    this.top = from;
    // 带回只用实际收起时长，不含保持时钟的兜底余量，组头与收拢同时到位。
    if (lift && lift.distance > 0) this.lift = { target: from - lift.distance, clock: new FollowMotionClock(list, lift.duration) };
    activityOwners.set(list, this);
    this.keepReachable(this.reserve);
  }

  naturalPadding(): number {
    return Number.parseFloat(getComputedStyle(this.list).scrollPaddingBottom) || 0;
  }

  heldSpace(): number {
    return this.extra;
  }

  /**
   * 去掉临时空间后的自然滚动底部；内容不足一屏时为负，表示还差多少才能滚动，临时空间须一并补足。
   * 此时 scrollHeight 被可视高度兜住，不能据此反推，因此以列表末尾的哨兵位置作为内容结束处
   * （临时空间位于哨兵之后）；没有哨兵时退回按 scrollHeight 计算。
   */
  private naturalBottom(): number {
    const sentinel = this.list.querySelector<HTMLElement>(`:scope > ${BOTTOM_SENTINEL_SELECTOR}`);
    if (!sentinel) return Math.max(0, this.list.scrollHeight - this.list.clientHeight - this.extra);
    const end = sentinel.getBoundingClientRect().bottom - this.list.getBoundingClientRect().top - this.list.clientTop + this.list.scrollTop;
    const padding = Number.parseFloat(getComputedStyle(this.list).paddingBottom) || 0;
    return end + padding - this.list.clientHeight;
  }

  /**
   * 保持当前位置可达：收起期间固定保留 reserve；之后按所需补足，但不超过上一帧的保留量。
   * 取整数，避免与已取整的几何相减后低估 1px。
   */
  private keepReachable(reserve?: number): number {
    const needed = Math.max(0, Math.ceil(this.top - this.naturalBottom()));
    this.extra = reserve === undefined ? Math.min(this.extra, needed) : Math.max(reserve, needed);
    if (this.extra > 0) {
      this.list.style.setProperty(HOLD_PROPERTY, `${this.extra}px`);
      this.list.setAttribute(HOLD_ATTRIBUTE, "");
    } else this.clear();
    return this.extra;
  }

  private clear() {
    this.list.style.removeProperty(HOLD_PROPERTY);
    this.list.removeAttribute(HOLD_ATTRIBUTE);
  }

  /** 保持期间又有组开始收起：在已保留的空间上再保留这次的收回高度，重新计时；仍保持当前位置。 */
  extend(reserve: number, duration: number, live: boolean) {
    this.reserve = this.extra + reserve;
    this.duration = duration;
    this.clock.cancel();
    this.clock = new FollowMotionClock(this.list, duration);
    this.phase = "collapse";
    this.released = !live;
    this.keepReachable(this.reserve);
  }

  release() {
    this.released = true;
    if (this.phase === "hold") this.startRelease();
  }

  /**
   * 发送或用户接管滚动后：以实际位置为准只缩减空间，空间用完返回 true。
   * 传入 now 时按收起时钟区分阶段：收起的 CSS 过渡尚未结束时仍保留全部待收回高度，
   * 否则随后的收缩会让浏览器逐帧钳制位置；收起结束后才开始缩减，已 release 的转入收回阶段（交回后才推进）。
   */
  track(top: number, now?: number): boolean {
    this.top = top;
    this.stopLift();
    if (now !== undefined && this.phase === "collapse") {
      if (!this.clock.sample(now).finished) { this.keepReachable(this.reserve); return false; }
      this.phase = "hold";
      if (this.released) this.startRelease();
    }
    return this.keepReachable() <= 0;
  }

  private startRelease() {
    this.clock.cancel();
    this.clock = new FollowMotionClock(this.list, this.duration);
    this.phase = "release";
  }

  private stopLift() {
    this.lift?.clock.cancel();
    this.lift = null;
  }

  /** 按带回时钟上移；全部待收回高度仍保留，上移量不超过收回量，任一帧都可达。 */
  private advanceLift(now: number) {
    const lift = this.lift;
    if (!lift) return;
    const step = lift.clock.sample(now);
    this.top = step.finished ? lift.target : this.top + (lift.target - this.top) * step.fraction;
    if (step.finished) this.stopLift();
  }

  advance(now: number): { top: number; finished: boolean } {
    if (this.phase === "collapse") {
      // 持续的 CSS 收起逐帧补足会落后一帧被浏览器钳制，收起期间固定保留全部待收回高度。
      const step = this.clock.sample(now);
      this.advanceLift(now);
      this.keepReachable(this.reserve);
      if (!step.finished) return { top: this.top, finished: false };
      this.phase = "hold";
      if (this.released) this.startRelease();
    }
    if (this.phase === "hold") {
      // 内容已填满让出的空间：不再需要临时空间，交回普通跟随。
      return { top: this.top, finished: this.keepReachable() <= 0 };
    }
    const step = this.clock.sample(now);
    this.top += (this.target() - this.top) * step.fraction;
    this.keepReachable();
    return { top: this.top, finished: step.finished };
  }

  finish() {
    this.clock.cancel();
    this.stopLift();
    if (activityOwners.get(this.list) === this) activityOwners.delete(this.list);
    this.extra = 0;
    this.clear();
  }
}
