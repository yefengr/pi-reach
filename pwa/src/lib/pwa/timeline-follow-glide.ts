/**
 * 时间线滚动的平滑运动：临界阻尼弹簧，不引用 DOM、不持有 RAF。
 * 目标在运动中继续变化时保留当前速度，不像重复发起原生平滑滚动或固定时长过渡那样，
 * 每次从零加速或在末段一次补完新增距离（iOS 上会一冲一冲或突然一跳）。
 */
/** 跟随回复增长的角频率（1/ms）：约 180ms 收敛；以 200px/s 匀速增长时稳定滞后约 18px，留在底部留白内。 */
export const FOLLOW_GLIDE_OMEGA = 0.022;
/** 本端发送等短期过渡的角频率：约 150ms 到位，起步速度接近标准曲线，与 160ms 的输入区回缩同步。 */
export const TRANSITION_GLIDE_OMEGA = 0.05;
/** 积分子步长，保证长帧下仍稳定。 */
const GLIDE_SUBSTEP_MS = 4;
/** 跟随时单帧最多推进的时长；页面卡顿或后台恢复后不一次跳过整段。短期过渡与输入区回缩同一时钟，只防止长时间卡顿后的子步失控。 */
const FOLLOW_MAX_FRAME_MS = 64;
const TRANSITION_MAX_FRAME_MS = 1000;
/** 距目标不足该像素且几乎静止时视为到达。 */
const GLIDE_REST_PX = 0.5;
const GLIDE_REST_VELOCITY = 0.01;

export class FollowGlide {
  private velocity = 0;
  private time: number | null = null;

  private readonly maxFrameMs: number;

  constructor(private top: number, private readonly omega = FOLLOW_GLIDE_OMEGA) {
    this.maxFrameMs = omega === FOLLOW_GLIDE_OMEGA ? FOLLOW_MAX_FRAME_MS : TRANSITION_MAX_FRAME_MS;
  }

  /** 布局补偿（如顶部 padding 变化）整体平移当前位置，不改变速度。 */
  shift(delta: number): void {
    this.top += delta;
  }

  /** 推进到 now 并返回本帧位置；越过目标时停在目标上，不回弹。 */
  advance(now: number, target: number): { top: number; settled: boolean } {
    const elapsed = this.time === null ? 0 : Math.min(this.maxFrameMs, Math.max(0, now - this.time));
    this.time = now;
    const direction = Math.sign(target - this.top);
    for (let left = elapsed; left > 0; left -= GLIDE_SUBSTEP_MS) {
      const step = Math.min(GLIDE_SUBSTEP_MS, left);
      const acceleration = this.omega * this.omega * (target - this.top) - 2 * this.omega * this.velocity;
      this.velocity += acceleration * step;
      this.top += this.velocity * step;
    }
    if (direction !== 0 && Math.sign(target - this.top) !== direction) {
      this.top = target;
      this.velocity = 0;
    }
    const settled = Math.abs(target - this.top) <= GLIDE_REST_PX && Math.abs(this.velocity) < GLIDE_REST_VELOCITY;
    if (settled) {
      this.top = target;
      this.velocity = 0;
    }
    return { top: this.top, settled };
  }
}
