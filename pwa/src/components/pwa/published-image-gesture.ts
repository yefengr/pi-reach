export type ImageTransform = { scale: number; x: number; y: number };
export type ImagePoint = { x: number; y: number };
export const IMAGE_RESET: ImageTransform = { scale: 1, x: 0, y: 0 };
export const IMAGE_MAX_ZOOM = 8;
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
  const result = zoomImage(start, start.scale * distance(after) / initialDistance);
  if (result.scale === 1) return result;
  return { ...result, x: start.x + (after[0].x + after[1].x - before[0].x - before[1].x) / 2, y: start.y + (after[0].y + after[1].y - before[0].y - before[1].y) / 2 };
}
