# PWA 滚动条统一与滚动时显示（方案 v4）

日期：2026-10-26。状态：本地实现完成，自动化通过，待非覆盖式滚动条环境观感确认。方案经两轮独立只读审查；v2 修正继承语义错误，v3 修正白名单与 Portal 事实错误，v4 按用户决定把「滚动时显示」从时间线扩展到全部滚动区，并记录实现。

范围只含 PWA 前端样式与滚动状态标记，不涉及协议、Extension、Relay、部署。

## 1. 问题

用户在桌面 Chrome PWA 中反馈主界面滚动条观感错误，侧栏滚动条正常，并补充横向滚动条同样有问题。

截图量测（@2x，折算 CSS px）：

| 位置 | 轨道 | 滑块 | 占用宽度 | 判断 |
| --- | --- | --- | --- | --- |
| 会话消息区（纵向） | `#F9F9F9` 整条 | `#C0C0C0`，8px | 13px | 非覆盖式（占位式）原生滚动条，按系统浅色外观绘制，不随深色主题 |
| 侧栏列表（纵向） | 无（透明） | 灰，约 6px | 不计 | `thin` + `control-line` + 透明轨道 |
| 宽 Markdown 表格（横向） | `#F9F9F9` 整条 | 浅灰 | 约 13px 高 | 未加滚动条样式，与非覆盖式原生滚动条一致 |

## 2. 根因

1. **主滚动区没有颜色声明。** `pwa/src/app/globals.css` 的 `.pwa-message-list` 带 `scrollbar-gutter: stable`，但没有 `scrollbar-width`／`scrollbar-color`；在非覆盖式滚动条环境下浏览器按系统外观绘制 13px 轨道，深色主题里表现为整条发白竖条。
2. **滚动条样式是错位的白名单。** 原分组里的选择器与实际滚动容器并不对应：`.pwa-markdown pre` 实际能匹配代码块内部的 `pre`（`MarkdownContent` 把 ReactMarkdown 包在 `.pwa-markdown` 内，结构为 `.pwa-markdown .pwa-code-block > pre`）；`.pwa-markdown table` 命中的是表格本体，而横向滚动容器是外层 `.pwa-markdown-table`。真正未被覆盖的滚动容器：`.pwa-markdown-table`、`.pwa-tool-text`／`.pwa-tool-call`／`.pwa-tool-diff-output`、`.pwa-file-reader-scroll`、`.pwa-settings-view`、`.pwa-workspace-state`、`.pwa-status-error > span`。
3. **标准属性的继承语义不一致。** Chrome 156 实测：`scrollbar-width` **不继承**（父 `thin`、子仍 `auto`），`scrollbar-color` **继承**。因此宽度必须逐元素设置，颜色可以靠继承统一。
4. **能力边界。** `scrollbar-width` 只有 `auto`／`thin`／`none`，`scrollbar-color` 只接受颜色，二者都不能控制圆角与精确像素宽度；`::-webkit-scrollbar*` 可精确控制，但会让同元素上的标准属性失效，并把 Chrome/Safari 桌面滚动条切成占位式，Firefox 与移动端不支持。

## 3. 目标与非目标

目标：

- 横向与纵向滚动条统一为 `thin` + `control-line` 滑块 + 透明轨道，不再出现整条浅色轨道。
- **全部滚动区**（时间线、宽表格、代码块、工具输出、文件阅读器、导航、排队消息、命令菜单、设置页、主区空态）改为「滚动时出现，静止隐藏」。
- 显隐不改变布局宽度；脚本未就绪时不出现「滚动条彻底消失」的无障碍风险。
- 去掉会过期的手工白名单，`DESIGN`、代码注释与自动化断言形成同一条规则。

非目标：

- 自绘滚动条（隐藏原生 + JS 绘制 thumb）及其拖动、resize 几何维护。
- `::-webkit-scrollbar*` 精确像素宽度与圆角。
- 协议、Extension、Relay 与部署流程。

## 4. 方案（v4）

### 4.1 统一规则（`pwa/src/app/globals.css`）

```css
:root,
:root * {
  scrollbar-width: thin;
}

:root { scrollbar-color: var(--pwa-control-line) transparent; }
:root[data-scroll-hints] { scrollbar-color: transparent transparent; }
:root[data-scroll-hints] [data-scrolling] { scrollbar-color: var(--pwa-control-line) transparent; }
```

宽度逐元素设置（不继承）；颜色写在 `:root` 上沿继承链覆盖全部容器，包括 Mantine 挂到 `document.body` 的浮层。`:root[data-scroll-hints]` 把「静止隐藏」绑定在脚本就绪状态上：脚本失败或尚未执行时滚动条保持可见（`thin` + 灰色），不会出现无法滚动却看不见滚动条的界面。

### 4.2 滚动状态标记（新增 `pwa/src/lib/ui/scroll-indicator.ts`）

```ts
useScrollIndicator(); // 在 PwaAppContent 挂载一次
```

`scroll` 事件不冒泡，但捕获阶段能到达 document，因此只挂一个被动捕获监听：滚动时给事件目标元素（任意滚动容器，含 body 上的浮层）加 `data-scrolling="true"`，约 800ms 无滚动后摘除；定时器以元素为键，卸载时统一清理并移除根属性。`message-list.tsx` 不改，时间线不需要自己的滚动状态逻辑。

### 4.3 文档与注释

- `docs/DESIGN.md` 滚动条行改写为统一规则与显隐语义。
- `globals.css` 滚动条注释写明「宽度不继承、颜色继承、`data-scroll-hints` 降级」。
- `attachment-cards.css` 删除与全局规则重复的声明。

## 5. 改动清单

| 文件 | 改动 |
| --- | --- |
| `pwa/src/lib/ui/scroll-indicator.ts`（新增） | 捕获监听、`data-scrolling` 标记、800ms 延迟、卸载清理、`data-scroll-hints` 开关注入 |
| `pwa/src/components/pwa/pwa-app.tsx` | 在 `PwaAppContent` 挂载 `useScrollIndicator()` |
| `pwa/src/app/globals.css` | 统一宽度/颜色规则、静止隐藏与滚动显示规则；删除原白名单；注释改写 |
| `pwa/src/components/pwa/attachment-cards.css` | 删除重复的 `scrollbar-width`／`scrollbar-color` |
| `docs/DESIGN.md` | 滚动条规则改写 |
| `pwa/src/lib/ui/scroll-indicator.browser.test.tsx`（新增） | 浅/深两套静止态、真实容器覆盖、单容器滚动隔离、连续滚动、卸载清理、未挂载时保持可见 |

## 6. 验证

已执行（2026-10-26，本机 macOS + Chrome 156）：

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter pwa typecheck` | 通过 |
| `pnpm --filter pwa lint` | 0 error，4 条既有 warning（与本改动无关） |
| `vitest run --project browser src/lib/ui/scroll-indicator.browser.test.tsx` | 8/8 通过 |
| `vitest run --project browser src/components/pwa/markdown-table.browser.test.tsx src/components/pwa/attachment-cards.browser.test.tsx` | 15/15 通过 |
| `vitest run --project browser src/components/pwa/mobile-swipe.browser.test.tsx` | 20/20 通过（横向容器尺寸变化未影响断言） |
| `vitest run --project node src/app/pwa-style-guard.node.test.ts src/app/pwa-theme-contrast.node.test.ts` | 33/33 通过 |
| `pnpm check:docs` | 92 篇已跟踪文档链接通过 |
| `git diff --check` | 通过 |

覆盖内容：每个真实滚动容器类名在浅/深两套主题下计算值为 `scrollbar-width: thin` 且 `scrollbar-color` 为透明；滚动某个容器后只有它的滑块显示（颜色为当主题 `control-line`），800ms 后回到透明；连续滚动不提前隐藏；卸载后根属性与标记清理；未挂载监听时滚动条保持可见。

未覆盖：本机为覆盖式滚动条（`offsetWidth - clientWidth = 0`），13px 轨道环境下的真实几何与最终观感需用户在非覆盖式环境确认；未运行全量浏览器回归与 Docker／双 Owner E2E。

## 7. 决策记录

- 方案选择：标准属性（A1），不用 `::-webkit-scrollbar*`；因此粗细由浏览器 `thin` 绘制，圆角与像素宽度不可控。
- 显隐范围：用户选择「只在滚动时显示」，覆盖全部滚动区，不保留「内部滚动区常显」。代价是宽表格、代码块静止时看不出可以横滚；悬停显示方案（B）已被否决。
- 设置页与主区空态不再单独决定，统一规则自动包含。

## 8. 风险与取舍

- **程序化滚动同样会显示滑块。** 发送后贴底、流式输出跟随、切换会话定位都会触发 `scroll`，时间线滑块在跟随期间保持可见、停止后约 800ms 隐藏；与原生覆盖式滚动条行为一致，但比「完全静止才出现」更频繁。
- **横向可发现性下降。** 宽表格与长代码块静止时不显示滑块，用户可能漏掉右侧内容；滚动或触摸横滑后出现。这是「全部隐藏」的既定代价。
- **透明轨道的残留绘制未知。** 非覆盖式滚动条在透明轨道色下是否仍绘制 1px 分隔线，本机无法复现；若残留，需追加 `::-webkit-scrollbar` 兜底（届时标准属性对该元素失效）。
- **静止态滑块不可见即不可发现**，Chrome 对透明滑块是否仍响应拖动未验证，不作为交互承诺；键盘与滚轮不受影响。
- **全局标记写入。** 任意滚动容器都会获得 `data-scrolling` 属性并触发一次定时器，性能可忽略；但若未来某个容器在滚动回调里观察属性变化，需自行排除该属性。
- **降级路径依赖脚本。** 若 `useScrollIndicator` 未挂载（脚本异常、非 PWA 根环境），滚动条保持 `thin` + 灰色常显，不会变成不可见。

## 9. 证据

- 截图量测：消息区滚动条 13px、轨道 `#F9F9F9`、滑块 `#C0C0C0`；侧栏滑块约 6px、无轨道；宽表格横向条同为 `#F9F9F9` 轨道。
- 本机 Chrome 156 探针：`.pwa-message-list` 原有 computed `scrollbar-width/color` 为 `auto/auto`，侧栏为 `thin` + `rgb(132,132,132) rgba(0,0,0,0)`；两者 gutter 均为 0（覆盖式）。
- 继承语义探针：父 `scrollbar-width: thin` 时子元素仍为 `auto`；父 `scrollbar-color: rgb(255,0,0) rgb(0,255,0)` 时子元素继承同值。
- 捕获语义探针：`document` 上的捕获监听能收到元素滚动事件（`scroll` 不冒泡，bubble 阶段计数为 0）。
- 生产构建 CSS 中原应用没有 `::-webkit-scrollbar` 规则（仅有 Mantine ScrollArea 的 `display:none`）。
