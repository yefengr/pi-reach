/**
 * 跟随中 Pi 回复增长的滚动运动：临界阻尼弹簧，不引用 DOM、不持有 RAF。
 * 目标在运动中继续增长时保留当前速度，不像重复发起原生平滑滚动那样每次从零加速（iOS 上会一冲一冲）。
 */
/** 角频率（1/ms）：约 180ms 收敛；以 200px/s 匀速增长时稳定滞后约 18px，留在底部留白内。 */
const GLIDE_OMEGA = 0.022;
/** 积分子步长，保证长帧下仍稳定。 */
const GLIDE_SUBSTEP_MS = 4;
/** 单帧最多推进的时长；页面卡顿或后台恢复后不一次跳过整段。 */
const GLIDE_MAX_FRAME_MS = 64;
/** 距目标不足该像素且几乎静止时视为到达。 */
const GLIDE_REST_PX = 0.5;
const GLIDE_REST_VELOCITY = 0.01;

export class FollowGlide {
  private velocity = 0;
  private time: number | null = null;

  constructor(private top: number) {}

  /** 推进到 now 并返回本帧位置；目标只向下增长，不越过目标回弹。 */
  advance(now: number, target: number): { top: number; settled: boolean } {
    const elapsed = this.time === null ? 0 : Math.min(GLIDE_MAX_FRAME_MS, Math.max(0, now - this.time));
    this.time = now;
    for (let left = elapsed; left > 0; left -= GLIDE_SUBSTEP_MS) {
      const step = Math.min(GLIDE_SUBSTEP_MS, left);
      const acceleration = GLIDE_OMEGA * GLIDE_OMEGA * (target - this.top) - 2 * GLIDE_OMEGA * this.velocity;
      this.velocity += acceleration * step;
      this.top += this.velocity * step;
    }
    if (this.top >= target) {
      this.top = target;
      this.velocity = Math.min(0, this.velocity);
    }
    const settled = target - this.top <= GLIDE_REST_PX && Math.abs(this.velocity) < GLIDE_REST_VELOCITY;
    if (settled) {
      this.top = target;
      this.velocity = 0;
    }
    return { top: this.top, settled };
  }
}
