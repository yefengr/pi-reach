import { PAIRING_QR_HEIGHT, PAIRING_QR_WIDTH } from "./fixtures/pairing-qr";

type QrImageOptions = {
  scale?: number;
  background?: number;
  rotation?: number;
  shear?: number;
};

/** 从固定模块采样 RGBA；黑白二维码及白边不随终端主题反色。 */
export function pairingQrImage(modules: string, { scale = 8, background = 255, rotation = 0, shear = 0 }: QrImageOptions = {}) {
  const packed = atob(modules);
  const padding = scale * 6;
  const width = PAIRING_QR_WIDTH * scale + padding * 2;
  const height = PAIRING_QR_HEIGHT * scale + padding * 2;
  const data = new Uint8ClampedArray(width * height * 4);
  const angle = rotation * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const rotatedY = -sine * dx + cosine * dy;
      const sourceX = (cosine * dx + sine * dy - shear * rotatedY + PAIRING_QR_WIDTH * scale / 2) / scale;
      const sourceY = (rotatedY + PAIRING_QR_HEIGHT * scale / 2) / scale;
      let value = background;
      if (sourceX >= 0 && sourceX < PAIRING_QR_WIDTH && sourceY >= 0 && sourceY < PAIRING_QR_HEIGHT) {
        const bit = Math.floor(sourceY) * PAIRING_QR_WIDTH + Math.floor(sourceX);
        value = (packed.charCodeAt(bit >> 3) >> (7 - (bit & 7))) & 1 ? 0 : 255;
      }
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}
