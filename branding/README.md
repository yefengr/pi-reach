# 品牌资产

本目录保存 Pi Reach 的「Pi Reach」字标。当前标识、图标与字标的真源如下：

| 内容 | 真源 | 说明 |
| --- | --- | --- |
| 标识几何与界面内渲染 | [`pwa/src/components/pwa/brand-mark.tsx`](../pwa/src/components/pwa/brand-mark.tsx) | 「桥」单色几何 π，`currentColor` |
| favicon、单色 Logo 与安装图标 | `pwa/scripts/render-brand-icons.mjs` 生成 | 输出 `pwa/public/icon.svg`、`pwa/public/logo.svg`、`pwa/public/app-icon-192.png`、`pwa/public/app-icon-512.png`、`pwa/public/apple-touch-icon.png` |
| 「Pi Reach」字标 | [`wordmark.svg`](wordmark.svg)（本目录） | 标识＋产品名的可伸缩 SVG |

规则见 [`docs/DESIGN.md`](../docs/DESIGN.md) 的「品牌资产」段。

## 当前标识

「桥」：单色几何 π，一体化横梁、柔和外侧端点与延伸右腿，无角标。主色为雾蓝 `#446396`（钢雾蓝提纯，见 [ADR-20261001](../docs/adr/20261001-neutral-surfaces-mist-blue.md)），界面浅色与深色共用。`favicon`（`icon.svg`）为雾蓝圆角底加白色标识；安装图标与 `apple-touch-icon.png` 为满版雾蓝底、标识居中于 80% 安全区内；`logo.svg` 为透明底雾蓝单色标识。以上文件由 `pwa/scripts/render-brand-icons.mjs` 生成，不通过手工 SVG→PNG 转换维护。

## 字标 wordmark.svg

可伸缩的「Pi Reach」字标：左侧为与 `BrandMark`／`render-brand-icons.mjs` 相同的「桥」几何路径，右侧为 SVG 原生 `text`。

- 只使用内置系统字体栈（与界面 `--pwa-font-ui` 一致），不引用网络字体、外部样式或任何外链资源，可在 README 等隔离渲染环境中直接显示。
- 单色雾蓝，用于需要「标识＋产品名」锁定的场景，如文档页眉、包页面。
- 顶部图片在 [README](../README.md) 中使用的是 PWA 生成的 `pwa/public/logo.svg`（仅标识）；需要字标时改用本文件。

## 更新方式

- 修改标识几何：同时更新 `pwa/src/components/pwa/brand-mark.tsx` 与 `pwa/scripts/render-brand-icons.mjs`，重新运行脚本生成 `pwa/public/` 下的图标，并同步 `wordmark.svg` 中的路径。
- 修改字标：只编辑 `wordmark.svg`；保持内置系统字体栈、单色雾蓝与无外链引用。
- 变更主色或标识外形前，先更新本文件、[`docs/DESIGN.md`](../docs/DESIGN.md)「品牌资产」段与品牌刷新方案，说明版本与原因。
