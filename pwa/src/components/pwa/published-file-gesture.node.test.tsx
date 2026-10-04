import { expect, test } from "vitest";
import { IMAGE_RESET, imageGesture, zoomImage } from "./published-image-gesture";
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
