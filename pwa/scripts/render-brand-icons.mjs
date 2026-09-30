#!/usr/bin/env node
// 生成 Pi Reach「桥」标识的 favicon、单色 Logo 与安装图标。
// 用法（在 pwa/ 下）：node scripts/render-brand-icons.mjs
// 标识几何与 src/components/pwa/brand-mark.tsx 相同；修改时两处同步，并重新运行本脚本。
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const STEEL = "#4C658D";
const MARK = [
  "M13 17h31c3 0 5 2 5 5v4H13c-1.1 0-2-.9-2-2v-5c0-1.1.9-2 2-2Z",
  "M17 26h8v22c0 1.1-.9 2-2 2h-4c-1.1 0-2-.9-2-2V26Z",
  "M40 26h8v17c0 5 2 6 7 5v7c-10 2-15-2-15-11V26Z",
];
const paths = (fill) => MARK.map((d) => `<path fill="${fill}" d="${d}"/>`).join("");

// favicon：钢雾蓝圆角底，标识放大填满，保证 16px 下可辨。
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="9" fill="${STEEL}"/><g transform="translate(-3.84 -7.84) scale(1.12)">${paths("#FFFFFF")}</g></svg>\n`;
// 单色标识：透明底，钢雾蓝。
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${paths(STEEL)}</svg>\n`;
// 安装图标：满版钢雾蓝底，标识缩放后位于中央 80% 直径安全区内，同时满足 any 与 maskable。
const install = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${STEEL}"/><g transform="translate(8.96 6) scale(.72)">${paths("#FFFFFF")}</g></svg>`;

await writeFile(`${publicDir}icon.svg`, favicon);
await writeFile(`${publicDir}logo.svg`, logo);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [file, size] of [["app-icon-192.png", 192], ["app-icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0">${install.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.locator("svg").screenshot({ path: `${publicDir}${file}`, omitBackground: false });
  }
} finally {
  await browser.close();
}
console.log("brand icons written to public/");
