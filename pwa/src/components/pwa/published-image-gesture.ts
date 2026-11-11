import { rubberBand } from "./swipe-gesture";

export type ImageTransform = { scale: number; x: number; y: number };
export type ImagePoint = { x: number; y: number };
export const IMAGE_RESET: ImageTransform = { scale: 1, x: 0, y: 0 };
export const IMAGE_MAX_ZOOM = 8;
/** 双击放大的目标倍率；已放大或平移时双击复位。 */
export const IMAGE_DOUBLE_TAP_ZOOM = 2;
/** 两次点按间隔与落点距离都在此范围内才算双击。 */
export const IMAGE_DOUBLE_TAP_MS = 300;
export const IMAGE_DOUBLE_TAP_RADIUS_PX = 40;
/** 按下到松手的移动不超过它才算点按。 */
export const IMAGE_TAP_SLOP_PX = 10;
/** 未缩放时下拉关闭：松手后的惯性停点越过这段距离即关闭。 */
export const IMAGE_PULL_DISMISS_PX = 120;
/** 下拉过程中图片随位移缩小的下限，对应下拉一个舞台高度。 */
export const IMAGE_PULL_MIN_SCALE = 0.7;
/** 捏合缩小到原始大小以下时带阻尼继续跟手，越界部分逼近该比例（倍率不低于 1 减去它），松手弹回原始大小。 */
export const IMAGE_UNDERZOOM_LIMIT = 0.5;
export function zoomImage(value: ImageTransform, scale: number): ImageTransform {
  const bounded = Math.max(1, Math.min(IMAGE_MAX_ZOOM, scale));
  return bounded === 1 ? { ...IMAGE_RESET } : { ...value, scale: bounded };
}
export function imageGesture(start: ImageTransform, before: readonly ImagePoint[], after: readonly ImagePoint[]): ImageTransform {
  if (!before.length || before.length !== after.length) return start;
  if (before.length === 1) return start.scale === 1 ? start : { ...start, x: start.x + after[0].x - before[0].x, y: start.y + after[0].y - before[0].y };
  const distance = (points: readonly ImagePoint[]) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  const initialDistance = distance(before);
  if (initialDistance === 0) return start;
  const raw = start.scale * distance(after) / initialDistance;
  const shift = { x: (after[0].x + after[1].x - before[0].x - before[1].x) / 2, y: (after[0].y + after[1].y - before[0].y - before[1].y) / 2 };
  // 原始大小以下：图片绕原位中心继续缩小并跟随两指中点，由调用方在松手时弹回。
  if (raw < 1) return { scale: 1 - rubberBand(1 - raw, IMAGE_UNDERZOOM_LIMIT), ...shift };
  const result = zoomImage(start, raw);
  if (result.scale === 1) return result;
  return { ...result, x: start.x + shift.x, y: start.y + shift.y };
}

/** 以屏幕上的 point 为不动点缩放；origin 为图片当前绘制的中心（缩放绕中心进行，已含平移）。 */
export function zoomImageAt(value: ImageTransform, scale: number, point: ImagePoint, origin: ImagePoint): ImageTransform {
  const result = zoomImage(value, scale);
  if (result.scale === 1) return result;
  const ratio = 1 - result.scale / value.scale;
  return { scale: result.scale, x: value.x + (point.x - origin.x) * ratio, y: value.y + (point.y - origin.y) * ratio };
}

/** 双击：处于原始大小时在落点放大，否则复位。 */
export function doubleTapImage(value: ImageTransform, point: ImagePoint, origin: ImagePoint): ImageTransform {
  const fit = value.scale === 1 && value.x === 0 && value.y === 0;
  return fit ? zoomImageAt(value, IMAGE_DOUBLE_TAP_ZOOM, point, origin) : { ...IMAGE_RESET };
}

/** 下拉位移对应的图片缩放：线性缩到下限，不再更小。 */
export function pullScale(distance: number, stageHeight: number): number {
  if (!(stageHeight > 0) || distance <= 0) return 1;
  return 1 - Math.min(distance / stageHeight, 1) * (1 - IMAGE_PULL_MIN_SCALE);
}
