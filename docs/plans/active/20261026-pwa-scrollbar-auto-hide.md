# PWA 滚动条统一与滚动时显示（方案 v7）

日期：2026-10-26。状态：本地实现完成，自动化通过，staging 待重新部署确认。方案经两轮独立只读审查；v2 修正继承语义错误，v3 修正白名单与 Portal 事实错误，v4 把「滚动时显示」扩展到全部滚动区，v5 增加淡入淡出并在加载更早记录期间抑制显示，v6 把隐藏延迟定为 3s，v7 按 PR #145 的审查与 CI 结果把过渡限定到真正滚动过的容器，并让显示不再向下继承。

范围只含 PWA 前端样式与滚动状态标记，不涉及协议、Extension、Relay、部署。

## 1. 问题

用户在桌面 Chrome PWA 中反馈主界面滚动条观感错误，侧栏滚动条正常，并补充横向滚动条同样有问题；随后补充两点体验要求：滚动条不应在停止滚动后立刻消失、滑块因内容高度变化而突然变短时应尽量不让人看到。

截图量测（@2x，折算 CSS px）：

| 位置 | 轨道 | 滑块 | 占用宽度 | 判断 |
| --- | --- | --- | --- | --- |
| 会话消息区（纵向） | `#F9F9F9` 整条 | `#C0C0C0`，8px | 13px | 非覆盖式（占位式）原生滚动条，按系统浅色外观绘制，不随深色主题 |
| 侧栏列表（纵向） | 无（透明） | 灰，约 6px | 不计 | `thin` + `control-line` + 透明轨道 |
| 宽 Markdown 表格（横向） | `#F9F9F9` 整条 | 浅灰 | 约 13px 高 | 未加滚动条样式，与非覆盖式原生滚动条一致 |

## 2. 根因

1. **主滚动区没有颜色声明。** `.pwa-message-list` 带 `scrollbar-gutter: stable`，但没有 `scrollbar-width`／`scrollbar-color`；在非覆盖式滚动条环境下浏览器按系统外观绘制 13px 轨道，深色主题里表现为整条发白竖条。
2. **滚动条样式是错位的白名单。** `.pwa-markdown pre` 实际能匹配代码块内部的 `pre`；`.pwa-markdown table` 命中的是表格本体，而横向滚动容器是外层 `.pwa-markdown-table`。真正未被覆盖的滚动容器：`.pwa-markdown-table`、`.pwa-tool-text`／`.pwa-tool-call`／`.pwa-tool-diff-output`、`.pwa-file-reader-scroll`、`.pwa-settings-view`、`.pwa-workspace-state`、`.pwa-status-error > span`。
3. **标准属性的继承语义不一致。** Chrome 156 实测：`scrollbar-width` **不继承**（父 `thin`、子仍 `auto`），`scrollbar-color` **继承**。因此宽度必须逐元素设置，颜色可以靠继承统一。
4. **滑块长度是浏览器派生量。** 长度由「内容高度／视口高度」实时计算，标准属性没有可表达它的接口，也没有过渡；内容插入时长度瞬变。要弱化只能降低可见性（自动隐藏）或在内容变化期间抑制显示。

## 3. 目标与非目标

目标：

- 横向与纵向滚动条统一为 `thin` + `control-line` 滑块 + 透明轨道，不再出现整条浅色轨道。
- **全部滚动区**改为「滚动时出现，停止 3s 后隐藏」，出现与消失为 120ms 淡入淡出。
- 加载更早记录期间抑制时间线滚动条显示，避免看到滑块因内容插入而突然变短。
- 显隐不改变布局宽度；脚本未就绪时不出现「滚动条彻底消失」的无障碍风险。
- 去掉会过期的手工白名单，`DESIGN`、代码注释与自动化断言形成同一条规则。

非目标：

- 自绘滚动条（隐藏原生 + JS 绘制 thumb）及滑块长度的过渡动画。
- `::-webkit-scrollbar*` 精确像素宽度与圆角。
- 协议、Extension、Relay 与部署流程。

## 4. 方案（v5）

### 4.1 统一规则（`pwa/src/app/globals.css`）

```css
:root,
:root * {
  scrollbar-width: thin;
}

/* 过渡只挂在真正滚动过的容器上，避免全局 transition 覆盖组件自身的布局过渡（如侧栏收展）。 */
[data-scroll-host] {
  transition: scrollbar-color var(--pwa-duration-fade) var(--pwa-ease-standard);
}

:root { scrollbar-color: var(--pwa-control-line) transparent; }
:root[data-scroll-hints] { scrollbar-color: transparent transparent; }
/* 显示只作用于被滚动的那个容器：后代重置为透明，避免消息内表格、代码块继承出可见滑块。 */
:root[data-scroll-hints] [data-scrolling] :where(*) { scrollbar-color: transparent transparent; }
:root[data-scroll-hints] [data-scrolling]:not([data-scroll-hold]) { scrollbar-color: var(--pwa-control-line) transparent; }
```

宽度逐元素设置（不继承）；颜色写在 `:root` 上沿继承链覆盖全部容器，包括 Mantine 挂到 `document.body` 的浮层。`:root[data-scroll-hints]` 把「静止隐藏」绑定在脚本就绪状态上，脚本失败时滚动条保持可见。`transition` 只挂在被滚动过的容器（`data-scroll-host`）上：全局 `transition` 简写会以相同优先级覆盖 `.pwa-root` 的侧栏收展过渡，并让继承的颜色变化在整棵子树上各建一个过渡对象。减少动态效果时，全局 `prefers-reduced-motion` 规则把过渡属性收窄为颜色类，滚动条改为瞬切。

### 4.2 滚动状态标记（`pwa/src/lib/ui/scroll-indicator.ts`）

`scroll` 不冒泡，但捕获阶段能到达 document，因此只挂一个被动捕获监听：滚动时给事件目标元素加 `data-scroll-host`（首次）与 `data-scrolling="true"`（每次），`SCROLL_HIDE_DELAY_MS = 3000` 无滚动后摘除 `data-scrolling`；定时器以元素为键，卸载时统一清理并移除根属性。`message-list.tsx` 不参与显隐逻辑，只在 `loadingEarlier` 时给滚动容器加 `data-scroll-hold`。

### 4.3 嵌套容器互不影响

`scrollbar-color` 继承，若父容器滚动时直接把可见颜色传下去，消息内嵌的宽表格、代码块会在没有滚动的情况下也显示滑块，而且它们的隐藏定时器不起作用。因此显示规则用 `[data-scrolling] :where(*)` 把后代重置为透明：只有被滚动的那个容器显示，后代要等自己滚动才显示。

### 4.4 内容高度变化时抑制显示

`.pwa-message-list[data-scroll-hold]` 命中 `:not([data-scroll-hold])` 的反向条件：加载更早记录期间即使处于滚动显示窗口也不显示滚动条，加载结束后滑块以新长度出现，用户看不到缩短过程。会话列表等由外部事件增长内容的容器不需要 hold——它们静止时本来就隐藏。

### 4.5 文档与注释

- `docs/DESIGN.md` 滚动条行改写为统一规则、3s 延迟、120ms 淡入淡出与 hold 语义。
- `globals.css` 注释写明继承语义、`data-scroll-hints` 降级与 `data-scroll-hold` 用途。
- `attachment-cards.css` 删除与全局规则重复的声明。

## 5. 改动清单

| 文件 | 改动 |
| --- | --- |
| `pwa/src/lib/ui/scroll-indicator.ts`（新增） | 捕获监听、`data-scroll-host`／`data-scrolling` 标记、3000ms 延迟、卸载清理、`data-scroll-hints` 开关注入 |
| `pwa/src/components/pwa/pwa-app.tsx` | 在 `PwaAppContent` 挂载 `useScrollIndicator()` |
| `pwa/src/app/globals.css` | 统一宽度/颜色规则、按容器淡入淡出、静止隐藏、后代重置与 hold 抑制；删除原白名单；注释改写 |
| `pwa/src/components/pwa/message-list.tsx` | `loadingEarlier` 时输出 `data-scroll-hold` |
| `pwa/src/components/pwa/attachment-cards.css` | 删除重复的 `scrollbar-width`／`scrollbar-color` |
| `docs/DESIGN.md` | 滚动条规则改写 |
| `pwa/src/lib/ui/scroll-indicator.browser.test.tsx`（新增） | 静止态、真实容器覆盖、单容器滚动隔离、嵌套容器互不影响、host 标记与过渡、连续滚动、hold 抑制与释放、卸载清理、未挂载时保持可见 |
| `pwa/src/components/pwa/message-list.browser.test.tsx` | 加载更早记录期间 hold 属性存在、结束后移除 |

## 6. 验证

已执行（2026-10-26，本机 macOS + Chrome 156）：

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter pwa typecheck` | 通过 |
| `pnpm --filter pwa lint` | 0 error（其余为既有 warning） |
| `pnpm --filter pwa build` | 通过 |
| `vitest run --project browser src/lib/ui/scroll-indicator.browser.test.tsx` | 10/10 通过 |
| `vitest run --project browser src/components/pwa/message-list.browser.test.tsx` | 85/85 通过 |
| `vitest run --project browser src/components/pwa/markdown-table.browser.test.tsx src/components/pwa/attachment-cards.browser.test.tsx` | 15/15 通过 |
| `vitest run --project browser src/components/pwa/mobile-swipe.browser.test.tsx` | 20/20 通过 |
| `vitest run --project browser src/components/pwa/pwa-app.browser.test.tsx` | 196/196 通过 |
| `vitest run --project browser src/components/pwa/use-page-transition.browser.test.tsx` | 15/15 通过 |
| `vitest run --project browser src/components/pwa/pwa-workspace-layout.browser.test.tsx` | 77/77 通过 |
| `vitest run --project browser src/components/pwa/tool-indicator-visibility.browser.test.tsx` | 16/16 通过 |
| `vitest run --project node src/app/pwa-style-guard.node.test.ts src/app/pwa-theme-contrast.node.test.ts` | 33/33 通过 |
| `pnpm check:docs` / `git diff --check` | 通过 |

覆盖内容：9 类真实容器的计算样式在浅/深两套主题下为 `thin` + 透明；滚动某个容器后只有它的滑块显示，3s 后回到透明；嵌套容器不因父容器滚动而显示；首次滚动同时写入 `data-scroll-host` 且该元素获得 `scrollbar-color` 过渡；连续滚动不提前隐藏；`data-scroll-hold` 期间不显示、释放后按新长度显示；卸载后根属性与标记清理；未挂载监听时保持可见；`MessageList` 在加载更早记录时确实输出 hold 属性。页面转场、工作区布局与工具指示三组动画计数测试通过，确认全局过渡不再干扰组件自身过渡。

未覆盖：本机为覆盖式滚动条（`offsetWidth - clientWidth = 0`），13px 轨道环境下的最终观感、透明轨道是否残留 1px 分隔线、淡入淡出的实际观感需在用户环境确认；未运行全量浏览器回归与 Docker／双 Owner E2E。

## 7. 决策记录

- 方案选择：标准属性（A1），不用 `::-webkit-scrollbar*`；粗细由浏览器 `thin` 绘制，圆角与像素宽度不可控。
- 显隐范围：用户选择「只在滚动时显示」，覆盖全部滚动区；悬停显示方案（B）已否决。
- 隐藏延迟：用户要求延长，取 3000ms（原 800ms → 2000ms → 3000ms）。
- 淡入淡出：`scrollbar-color` 在 Chrome 实测可过渡，使用 `--pwa-duration-fade`（120ms）。
- 长度瞬变：原生滑块长度无法过渡，改为「加载更早记录期间抑制显示」，不给自绘 thumb 做长度动画。
- PR #145 审查与 CI：Codex 指出全局 `transition` 覆盖 `.pwa-root` 的侧栏收展过渡、以及父容器滚动会让内嵌容器也显示滑块；CI 四个浏览器分片失败也由全局过渡引入的额外动画计数导致。v7 把过渡限定到 `data-scroll-host`，并给滚动容器的后代做颜色重置。

## 8. 风险与取舍

- **横向可发现性下降。** 宽表格与长代码块静止不显示滑块，用户可能漏掉右侧内容；滚动或横滑后出现。
- **程序化滚动同样会显示滑块。** 发送贴底、流式输出跟随、切换会话定位都会触发 `scroll`，滑块在跟随期间显示、停止 3s 后隐藏；与原生覆盖式行为一致，但比「完全静止才出现」更频繁。
- **透明轨道的残留绘制未知。** 非覆盖式滚动条在透明轨道色下是否仍绘制 1px 分隔线，本机无法复现；若残留，需追加 `::-webkit-scrollbar` 兜底（届时标准属性对该元素失效）。
- **静止态滑块不可见即不可发现**，Chrome 对透明滑块是否仍响应拖动未验证；键盘与滚轮不受影响。
- **过渡优先级。** 过渡只挂在被滚动过的容器上；若该容器自身另有 `transition` 声明，组件声明优先，淡入淡出回退为瞬切；不影响显隐正确性。减少动态效果时按系统设置瞬切。
- **全局标记写入。** 任意滚动容器都会获得 `data-scrolling` 属性并触发一次定时器；若未来某容器在滚动回调里观察属性变化，需自行排除该属性。

## 9. 证据

- 截图量测：消息区滚动条 13px、轨道 `#F9F9F9`、滑块 `#C0C0C0`；侧栏滑块约 6px、无轨道；宽表格横向条同为 `#F9F9F9` 轨道。
- 本机 Chrome 156 探针：`.pwa-message-list` 原有 computed `scrollbar-width/color` 为 `auto/auto`，侧栏为 `thin` + `rgb(132,132,132) rgba(0,0,0,0)`；两者 gutter 均为 0（覆盖式）。
- 继承语义：父 `scrollbar-width: thin` 时子元素仍为 `auto`；父 `scrollbar-color` 会传给子元素。
- 捕获语义：`document` 上的捕获监听能收到元素滚动事件（bubble 阶段计数为 0）。
- 过渡语义：`transition: scrollbar-color 400ms` 下 computed 值按 60ms 采样逐步插值（`rgba(132,132,132,0.875)` → `0.416` → …），说明可用作淡入淡出。
- 伪元素长度：`::-webkit-scrollbar-thumb { height: 80% }` 会把滑块画成 160px（而非按内容比例算出的 10px），说明该私有属性可覆盖长度但会让滑块不再指示滚动比例，因此不采用。
