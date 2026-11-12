import { expect, test } from "vitest";
import { doubleTapImage, IMAGE_DOUBLE_TAP_ZOOM, IMAGE_MAX_ZOOM, IMAGE_OVERZOOM_LIMIT, IMAGE_PULL_MIN_SCALE, IMAGE_RESET, IMAGE_UNDERZOOM_LIMIT, imageGesture, pullScale, zoomImage, zoomImageAt } from "./published-image-gesture";
import { fileSaveName, textFilePreview } from "@/lib/pwa/file-preview";

test("zoom, pinch and pan are bounded and reset at fit", () => {
  expect(zoomImage(IMAGE_RESET, 100).scale).toBe(8);
  expect(zoomImage({ scale: 3, x: 50, y: 30 }, 0)).toEqual(IMAGE_RESET);
  const pinch = imageGesture(IMAGE_RESET, [{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 0, y: 0 }, { x: 20, y: 0 }]);
  expect(pinch).toEqual({ scale: 2, x: 5, y: 0 });
  expect(imageGesture(pinch, [{ x: 10, y: 10 }], [{ x: 25, y: 30 }])).toEqual({ scale: 2, x: 20, y: 20 });
  expect(imageGesture(IMAGE_RESET, [{ x: 0, y: 0 }], [{ x: 20, y: 20 }])).toEqual(IMAGE_RESET);
  expect(imageGesture(pinch, [], [])).toEqual(pinch);
  expect(imageGesture(pinch, [{ x: 0, y: 0 }], [])).toEqual(pinch);
});

test("pinching below fit follows with resistance and never reaches the underzoom limit", () => {
  const pinch = (from: number, to: number) => imageGesture(IMAGE_RESET, [{ x: 0, y: 0 }, { x: from, y: 0 }], [{ x: 0, y: 0 }, { x: to, y: 0 }]);
  const half = pinch(100, 50);
  // 手指比例 0.5，越界部分按橡皮筋递减：缩小但远不到 0.5，且始终高于下限。
  expect(half.scale).toBeLessThan(1);
  expect(half.scale).toBeGreaterThan(0.75);
  expect(pinch(100, 10).scale).toBeLessThan(half.scale);
  expect(pinch(100, 1).scale).toBeGreaterThan(1 - IMAGE_UNDERZOOM_LIMIT);
  // 跟随两指中点；从放大状态捏回原始大小以下同样带阻尼。
  expect(half.x).toBe(-25);
  expect(imageGesture({ scale: 2, x: 40, y: 0 }, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 0, y: 0 }, { x: 25, y: 0 }]).scale).toBe(half.scale);
});

test("pinching above the zoom limit follows with resistance and never reaches the overzoom limit", () => {
  const start = { scale: IMAGE_MAX_ZOOM / 2, x: 30, y: 0 };
  const pinch = (to: number) => imageGesture(start, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 0, y: 0 }, { x: to, y: 0 }]);
  // 两指拉开到两倍正好到上限，不带阻尼。
  expect(pinch(200).scale).toBe(IMAGE_MAX_ZOOM);
  // 手指比例对应上限的两倍：超出部分按橡皮筋递减，高于上限但远不到两倍。
  const double = pinch(400);
  expect(double.scale).toBeGreaterThan(IMAGE_MAX_ZOOM);
  expect(double.scale).toBeLessThan(IMAGE_MAX_ZOOM * 1.3);
  expect(pinch(800).scale).toBeGreaterThan(double.scale);
  expect(pinch(100000).scale).toBeLessThan(IMAGE_MAX_ZOOM * (1 + IMAGE_OVERZOOM_LIMIT));
  // 平移照常跟随两指中点。
  expect(double.x).toBe(start.x + 150);
});

test("zooming at a point keeps that screen point fixed", () => {
  const origin = { x: 200, y: 300 };
  // 落点在图片中心：只改倍率，不平移。
  expect(zoomImageAt(IMAGE_RESET, 2, origin, origin)).toEqual({ scale: 2, x: 0, y: 0 });
  // 落点在中心右下 (30, 10)：放大 2 倍后中心向左上移开同样的距离。
  expect(zoomImageAt(IMAGE_RESET, 2, { x: 230, y: 310 }, origin)).toEqual({ scale: 2, x: -30, y: -10 });
  // 已有平移时在其基础上累加；缩回原始大小即复位。
  expect(zoomImageAt({ scale: 2, x: 10, y: 0 }, 4, { x: 220, y: 300 }, origin)).toEqual({ scale: 4, x: -10, y: 0 });
  expect(zoomImageAt({ scale: 2, x: 10, y: 0 }, 1, { x: 220, y: 300 }, origin)).toEqual(IMAGE_RESET);
});

test("double tap zooms in from fit and resets any zoomed or panned image", () => {
  const origin = { x: 100, y: 100 };
  expect(doubleTapImage(IMAGE_RESET, { x: 110, y: 100 }, origin)).toEqual({ scale: IMAGE_DOUBLE_TAP_ZOOM, x: -10 * (IMAGE_DOUBLE_TAP_ZOOM - 1), y: 0 });
  expect(doubleTapImage({ scale: 3, x: 40, y: -20 }, origin, origin)).toEqual(IMAGE_RESET);
});

test("pull scale shrinks linearly to its floor", () => {
  expect(pullScale(0, 600)).toBe(1);
  expect(pullScale(300, 600)).toBeCloseTo(1 - (1 - IMAGE_PULL_MIN_SCALE) / 2);
  expect(pullScale(5000, 600)).toBe(IMAGE_PULL_MIN_SCALE);
  expect(pullScale(100, 0)).toBe(1);
});

test("save name preserves Unicode and neutralizes path/control/reserved names", () => {
  expect(fileSaveName("成果 图.png")).toBe("成果 图.png");
  expect(fileSaveName("../unsafe\u0000.html")).not.toContain("/");
  expect(fileSaveName("CON.txt")).toBe("_CON.txt");
});

test("shared preview caps DOM work and retains valid UTF-8", () => {
  const preview = textFilePreview(new TextEncoder().encode("中文\n".repeat(300000)));
  expect(preview?.truncated).toBe(true);
  expect(preview?.text.length).toBeLessThanOrEqual(65536);
  expect(preview?.text.split("\n").length).toBeLessThanOrEqual(1000);
  expect(preview?.text).not.toContain("�");
});
