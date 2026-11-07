import jsQR from "jsqr";

/** 未定位到二维码是正常帧，不属于摄像头故障。 */
export function decodeQrImage(image: { data: Uint8ClampedArray; width: number; height: number }): string | null {
  return jsQR(image.data, image.width, image.height)?.data || null;
}
