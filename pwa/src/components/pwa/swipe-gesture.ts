export const SWIPE_SLOP_PX = 10;
export const SWIPE_DIRECTION_RATIO = 1.5;
export const SWIPE_COMMIT_DISTANCE_PX = 72;
export const SWIPE_FLICK_DISTANCE_PX = 32;
export const SWIPE_FLICK_VELOCITY = 0.4;
export const SWIPE_VELOCITY_WINDOW_MS = 100;

export type SwipeDirection = "left" | "right";
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

function signedDistance(state: ActiveSwipe, point: SwipePoint) {
  return (point.x - state.start.x) * (state.direction === "right" ? 1 : -1);
}

/** 面板跟手位移：从锁定方向的位置起算，反向不为负。 */
export function trackedDistance(state: SwipeState, point: SwipePoint): number {
  if (state.phase !== "tracking") return 0;
  return Math.max(0, signedDistance(state, point) - state.lockOffset);
}

export function moveSwipe(state: SwipeState, point: SwipePoint): SwipeState {
  if (state.phase === "idle" || state.pointerId !== point.pointerId || state.phase === "rejected") return state;
  let phase: ActiveSwipe["phase"] = state.phase;
  let lockOffset = state.lockOffset;
  if (phase === "pending" && Math.hypot(point.x - state.start.x, point.y - state.start.y) > SWIPE_SLOP_PX) {
    phase = signedDistance(state, point) > Math.abs(point.y - state.start.y) * SWIPE_DIRECTION_RATIO ? "tracking" : "rejected";
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
  let { x, time } = first;
  if (next && first.time < cutoff && next.time > first.time) {
    const fraction = (cutoff - first.time) / (next.time - first.time);
    x += (next.x - first.x) * fraction;
    time = cutoff;
  }
  if (end.time <= time) return 0;
  return (end.x - x) * (state.direction === "right" ? 1 : -1) / (end.time - time);
}

export type SwipeResult = {
  state: SwipeState;
  committed: boolean;
  velocity: number;
  /** 松手时的跟手位移（同 trackedDistance）。 */
  distance: number;
  /** 松手末速度反向且达到轻扫速度；跟手模式据此把已越过阈值的手势回弹。 */
  reversed: boolean;
};

export function finishSwipe(state: SwipeState, point: SwipePoint): SwipeResult {
  if (state.phase === "idle" || state.pointerId !== point.pointerId) return { state, committed: false, velocity: 0, distance: 0, reversed: false };
  const final = moveSwipe(state, point) as ActiveSwipe;
  const distance = signedDistance(final, point);
  const velocity = releaseVelocity(final, point);
  const committed = final.phase === "tracking" && (distance >= SWIPE_COMMIT_DISTANCE_PX || (distance >= SWIPE_FLICK_DISTANCE_PX && velocity >= SWIPE_FLICK_VELOCITY));
  return { state: IDLE_SWIPE, committed, velocity, distance: trackedDistance(final, point), reversed: velocity <= -SWIPE_FLICK_VELOCITY };
}

export function cancelSwipe(): SwipeState {
  return IDLE_SWIPE;
}
