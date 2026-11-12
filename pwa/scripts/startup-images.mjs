// iOS 主屏应用的启动图：每种设备尺寸、方向与深浅外观各一张 bg 纯色图。
// iOS 只采用与屏幕像素尺寸完全一致的启动图，没有匹配项时启动画面为白色；Android 的启动画面取安装清单底色，不在此列。
// 启动图不放文字和标识，与首屏底色一致，避免启动画面与首屏之间闪一下。
import { crc32, deflateSync } from "node:zlib";
import { DARK_THEME_COLOR, LIGHT_THEME_COLOR } from "../src/lib/ui/appearance.ts";

export const STARTUP_IMAGE_DIR = "startup";

export const STARTUP_SCHEMES = { light: LIGHT_THEME_COLOR, dark: DARK_THEME_COLOR };

/** 竖屏的逻辑宽高（pt）与像素密度；媒体查询中的 device-width／device-height 在横屏时仍取竖屏值。 */
export const STARTUP_DEVICES = [
  // iPhone
  { width: 375, height: 667, ratio: 2 }, // SE 第 2、3 代
  { width: 414, height: 736, ratio: 3 }, // 8 Plus
  { width: 375, height: 812, ratio: 3 }, // X、XS、11 Pro、12 mini、13 mini
  { width: 414, height: 896, ratio: 2 }, // XR、11
  { width: 414, height: 896, ratio: 3 }, // XS Max、11 Pro Max
  { width: 390, height: 844, ratio: 3 }, // 12、13、14、16e
  { width: 428, height: 926, ratio: 3 }, // 12 Pro Max、13 Pro Max、14 Plus
  { width: 393, height: 852, ratio: 3 }, // 14 Pro、15、15 Pro、16
  { width: 430, height: 932, ratio: 3 }, // 14 Pro Max、15 Plus、15 Pro Max、16 Plus
  { width: 402, height: 874, ratio: 3 }, // 16 Pro、17、17 Pro
  { width: 420, height: 912, ratio: 3 }, // Air
  { width: 440, height: 956, ratio: 3 }, // 16 Pro Max、17 Pro Max
  // iPad
  { width: 744, height: 1133, ratio: 2 }, // mini 第 6、7 代
  { width: 768, height: 1024, ratio: 2 }, // 9.7 英寸、mini 第 5 代
  { width: 810, height: 1080, ratio: 2 }, // 10.2 英寸
  { width: 820, height: 1180, ratio: 2 }, // Air 第 4、5 代及 11 英寸、iPad 第 10 代起
  { width: 834, height: 1112, ratio: 2 }, // Air 第 3 代、Pro 10.5 英寸
  { width: 834, height: 1194, ratio: 2 }, // Pro 11 英寸（第 1–4 代）
  { width: 834, height: 1210, ratio: 2 }, // Pro 11 英寸（M4 起）
  { width: 1024, height: 1366, ratio: 2 }, // Pro 12.9 英寸、Air 13 英寸
  { width: 1032, height: 1376, ratio: 2 }, // Pro 13 英寸（M4 起）
];

/** 每张启动图的文件名、像素尺寸、底色与媒体查询；不同设备像素尺寸相同时共用同一文件。 */
export function startupImages() {
  return STARTUP_DEVICES.flatMap((device) => ["portrait", "landscape"].flatMap((orientation) =>
    Object.entries(STARTUP_SCHEMES).map(([scheme, color]) => {
      const portrait = [device.width * device.ratio, device.height * device.ratio];
      const [pixelWidth, pixelHeight] = orientation === "portrait" ? portrait : [portrait[1], portrait[0]];
      return {
        path: `${STARTUP_IMAGE_DIR}/${scheme}-${pixelWidth}x${pixelHeight}.png`,
        pixelWidth,
        pixelHeight,
        color,
        media: `screen and (device-width: ${device.width}px) and (device-height: ${device.height}px) and (-webkit-device-pixel-ratio: ${device.ratio}) and (orientation: ${orientation}) and (prefers-color-scheme: ${scheme})`,
      };
    })));
}

export function startupImageLinks() {
  return startupImages().map((image) => `<link rel="apple-touch-startup-image" media="${image.media}" href="/${image.path}" />`).join("\n    ");
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_COLOR_GRAY = 0;
const PNG_COLOR_RGB = 2;
const PNG_FILTER_NONE = 0;
// 纯色图的后续行与上一行相同，Up 过滤后全为 0，压缩后只有几 KB。
const PNG_FILTER_UP = 2;

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** 生成一张 8 位纯色 PNG；中性灰（R=G=B）用单通道灰度，文件约为 RGB 的三分之一。 */
export function solidPng(width, height, hex) {
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const pixel = rgb.every((channel) => channel === rgb[0]) ? [rgb[0]] : rgb;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, pixel.length === 1 ? PNG_COLOR_GRAY : PNG_COLOR_RGB, 0, 0, 0], 8);
  const stride = 1 + width * pixel.length;
  const raw = Buffer.alloc(stride * height);
  raw[0] = PNG_FILTER_NONE;
  for (let x = 0; x < width; x += 1) raw.set(pixel, 1 + x * pixel.length);
  for (let y = 1; y < height; y += 1) raw[y * stride] = PNG_FILTER_UP;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
