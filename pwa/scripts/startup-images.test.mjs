import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import { DARK_THEME_COLOR, LIGHT_THEME_COLOR } from "../src/lib/ui/appearance.ts";
import { startupImageLinks, startupImages, STARTUP_DEVICES, STARTUP_IMAGE_DIR } from "./startup-images.mjs";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const indexHtml = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

/** 读出 PNG 的尺寸与左上角像素颜色（只支持本脚本生成的 8 位灰度或 RGB 图）。 */
function readPng(path) {
  const data = readFileSync(path);
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const colorType = data[25];
  const idat = [];
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(data.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const channels = colorType === 0 ? 1 : 3;
  const pixel = channels === 1 ? [raw[1], raw[1], raw[1]] : [raw[1], raw[2], raw[3]];
  const color = `#${pixel.map((channel) => channel.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
  return { width, height, color, rawLength: raw.length, stride: 1 + width * channels };
}

test("every device has portrait and landscape images in both appearances", () => {
  const images = startupImages();
  assert.equal(images.length, STARTUP_DEVICES.length * 2 * 2);
  for (const scheme of ["light", "dark"]) {
    assert.equal(images.filter((image) => image.media.endsWith(`(prefers-color-scheme: ${scheme})`)).length, STARTUP_DEVICES.length * 2);
  }
  assert.deepEqual(new Set(images.map((image) => image.color)), new Set([LIGHT_THEME_COLOR, DARK_THEME_COLOR]));
});

test("committed images match the device list in size and use the bg color of their appearance", () => {
  const expected = new Map(startupImages().map((image) => [image.path, image]));
  const files = readdirSync(`${publicDir}${STARTUP_IMAGE_DIR}`).map((name) => `${STARTUP_IMAGE_DIR}/${name}`).sort();
  // 改了设备清单或 bg 色却没重新生成时失败：在 pwa/ 下运行 node scripts/render-startup-images.mjs。
  assert.deepEqual(files, [...expected.keys()].sort());
  for (const [path, image] of expected) {
    const png = readPng(`${publicDir}${path}`);
    assert.deepEqual([png.width, png.height, png.color], [image.pixelWidth, image.pixelHeight, image.color], path);
    assert.equal(png.rawLength, png.stride * png.height, path);
  }
});

test("index.html receives one startup link per image", () => {
  assert.match(indexHtml, /<!-- startup-images -->/);
  const links = startupImageLinks();
  assert.equal(links.match(/rel="apple-touch-startup-image"/g)?.length, startupImages().length);
  for (const image of startupImages()) assert.ok(links.includes(`media="${image.media}" href="/${image.path}"`), image.path);
});
