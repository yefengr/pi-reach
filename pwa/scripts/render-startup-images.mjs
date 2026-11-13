#!/usr/bin/env node
// 生成 iOS 主屏应用的深浅两套启动图到 public/startup/。
// 用法（在 pwa/ 下）：node scripts/render-startup-images.mjs
// bg token（appearance.ts 的主题色）或设备清单变化后重新运行；scripts/startup-images.test.mjs 校验文件与清单、底色一致。
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { solidPng, startupImages, STARTUP_IMAGE_DIR } from "./startup-images.mjs";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const outputDir = `${publicDir}${STARTUP_IMAGE_DIR}`;

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
const unique = new Map(startupImages().map((image) => [image.path, image]));
for (const image of unique.values()) {
  await writeFile(`${publicDir}${image.path}`, solidPng(image.pixelWidth, image.pixelHeight, image.color));
}
console.log(`${unique.size} startup images written to public/${STARTUP_IMAGE_DIR}/`);
