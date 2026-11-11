export const SWIPE_SLOP_PX = 10;
export const SWIPE_DIRECTION_RATIO = 1.5;
export const SWIPE_COMMIT_DISTANCE_PX = 72;
export const SWIPE_FLICK_DISTANCE_PX = 32;
export const SWIPE_FLICK_VELOCITY = 0.4;
export const SWIPE_VELOCITY_WINDOW_MS = 100;
/** 跟手模式的松手判定：按 iOS 常规减速率（每毫秒保留 0.998）推算惯性停点，停点过表面行程的一半才提交。 */
export const SWIPE_PROJECTION_DECELERATION = 0.998;
export const SWIPE_PROJECTION_COMMIT_RATIO = 0.5;
/** 越界阻尼系数（iOS 滚动视图的橡皮筋公式）：越界位移 x 显示为 (1 - 1 / (x × 系数 / d + 1)) × d，逼近但不超过 d。 */
export const RUBBER_BAND_COEFFICIENT = 0.55;

/** 越界位移的阻尼显示值；dimension 为渐近上限（通常取表面自身尺寸）。 */
export function rubberBand(offset: number, dimension: number): number {
  if (!(offset > 0) || !(dimension > 0)) return 0;
  return (1 - 1 / (offset * RUBBER_BAND_COEFFICIENT / dimension + 1)) * dimension;
}

/** down 用于底部面板下拉关闭，up 用于顶部 Toast 上滑关闭；主轴为纵向，其余规则与左右一致。 */
export type SwipeDirection = "left" | "right" | "down" | "up";

const vertical = (direction: SwipeDirection) => direction === "down" || direction === "up";
export type SwipePoint = { pointerId: number; x: number; y: number; time: number };
type ActiveSwipe = {
  phase: "pending" | "tracking" | "rejected";
  direction: SwipeDirection;
  pointerId: number;
  start: SwipePoint;
  samples: SwipePoint[];
  /** 进入 tracking 那一刻的有符号位移；跟手显示从它起算，避免越过斜率阈值时跳变。 */
  lockOffset: number;
};
export type SwipeState = { phase: "idle" } | ActiveSwipe;
export const IDLE_SWIPE: SwipeState = { phase: "idle" };

export function beginSwipe(state: SwipeState, point: SwipePoint, direction: SwipeDirection, pointerType: string, isPrimary: boolean): SwipeState {
  if (state.phase !== "idle" || pointerType !== "touch" || !isPrimary) return state;
  return { phase: "pending", direction, pointerId: point.pointerId, start: point, samples: [point], lockOffset: 0 };
}

/** 主轴上朝手势方向为正的坐标。 */
function along(direction: SwipeDirection, point: SwipePoint) {
  if (vertical(direction)) return direction === "down" ? point.y : -point.y;
  return direction === "right" ? point.x : -point.x;
}

function across(direction: SwipeDirection, point: SwipePoint) {
  return vertical(direction) ? point.x : point.y;
}

function signedDistance(state: ActiveSwipe, point: SwipePoint) {
  return along(state.direction, point) - along(state.direction, state.start);
}

/** 面板跟手位移：从锁定方向的位置起算，反向不为负。 */
export function trackedDistance(state: SwipeState, point: SwipePoint): number {
  return Math.max(0, overscrollDistance(state, point));
}

/** 同 trackedDistance，但朝关闭的反方向越过起点时为负；供带越界阻尼的表面使用。 */
export function overscrollDistance(state: SwipeState, point: SwipePoint): number {
  if (state.phase !== "tracking") return 0;
  return signedDistance(state, point) - state.lockOffset;
}

export function moveSwipe(state: SwipeState, point: SwipePoint): SwipeState {
  if (state.phase === "idle" || state.pointerId !== point.pointerId || state.phase === "rejected") return state;
  let phase: ActiveSwipe["phase"] = state.phase;
  let lockOffset = state.lockOffset;
  if (phase === "pending" && Math.hypot(point.x - state.start.x, point.y - state.start.y) > SWIPE_SLOP_PX) {
    phase = signedDistance(state, point) > Math.abs(across(state.direction, point) - across(state.direction, state.start)) * SWIPE_DIRECTION_RATIO ? "tracking" : "rejected";
    if (phase === "tracking") lockOffset = signedDistance(state, point);
  }
  const samples = [...state.samples, point];
  // 保留采样窗口边界之前的一个点，以便插值；停顿期间也必须计入松手时间。
  while (samples.length > 2 && samples[1].time <= point.time - SWIPE_VELOCITY_WINDOW_MS) samples.shift();
  return { ...state, phase, samples, lockOffset };
}

function releaseVelocity(state: ActiveSwipe, end: SwipePoint): number {
  const [first, next] = state.samples;
  const cutoff = end.time - SWIPE_VELOCITY_WINDOW_MS;
  let position = along(state.direction, first);
  let { time } = first;
  if (next && first.time < cutoff && next.time > first.time) {
    const fraction = (cutoff - first.time) / (next.time - first.time);
    position += (along(state.direction, next) - position) * fraction;
    time = cutoff;
  }
  if (end.time <= time) return 0;
  return (along(state.direction, end) - position) / (end.time - time);
}

export type SwipeResult = {
  state: SwipeState;
  committed: boolean;
  velocity: number;
  /** 松手时的跟手位移（同 trackedDistance）。 */
  distance: number;
};

export function finishSwipe(state: SwipeState, point: SwipePoint): SwipeResult {
  if (state.phase === "idle" || state.pointerId !== point.pointerId) return { state, committed: false, velocity: 0, distance: 0 };
  const final = moveSwipe(state, point) as ActiveSwipe;
  const distance = signedDistance(final, point);
  const velocity = releaseVelocity(final, point);
  const committed = final.phase === "tracking" && (distance >= SWIPE_COMMIT_DISTANCE_PX || (distance >= SWIPE_FLICK_DISTANCE_PX && velocity >= SWIPE_FLICK_VELOCITY));
  return { state: IDLE_SWIPE, committed, velocity, distance: trackedDistance(final, point) };
}

/**
 * 跟手模式的提交判定：以松手位移加惯性滑行距离推算停点，过行程一半才提交。
 * velocity 为朝手势方向的有符号速度（像素／毫秒），反向甩回会把停点拉回；extent 为表面的全程位移。
 */
export function projectedCommit(distance: number, velocity: number, extent: number): boolean {
  if (!(extent > 0) || distance <= 0) return false;
  return projectedStop(distance, velocity) >= extent * SWIPE_PROJECTION_COMMIT_RATIO;
}

/** 松手后按惯性滑行推算的停点位移（像素）；velocity 为朝手势方向的有符号速度（像素／毫秒）。 */
export function projectedStop(distance: number, velocity: number): number {
  return distance + velocity * SWIPE_PROJECTION_DECELERATION / (1 - SWIPE_PROJECTION_DECELERATION);
}

export function cancelSwipe(): SwipeState {
  return IDLE_SWIPE;
}
