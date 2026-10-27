# 浮动入口与局部提示的进出动效

- 日期：2026-10-27
- 用途：为「最新」等浮动入口与主区提示条补一条统一的进出规则，并按规则实现；本文不是当前实现说明。
- 项目级状态：见 [ROADMAP](../../ROADMAP.md)，不在本文另设状态表。
- 当前事实来源：[DESIGN「动效」](../../DESIGN.md#基础层)与[「动效时长」](../../DESIGN.md#动效时长)。

## 1. 背景

DESIGN 的进入／退出曲线与位移只点名 Modal、Popover、Menu、Toast。浮在会话内容上的入口和主区提示区的提示条没有进出规则，样式中也没有对应过渡，目前都是瞬间出现、瞬间消失。2026-10-27 调整「最新」显示时机时发现这一缺口。

## 2. 范围

| 控件 | 组件 | 位置 | 是否占布局 | 出现／消失的时机 |
| --- | --- | --- | --- | --- |
| 「最新」／「N 条新输出」 | `PwaMessageActions` | 输入区上方浮动（`.pwa-message-actions`，绝对定位） | 否 | 离底部超过一屏且滚动停下，或有未读输出；回到一屏内或恢复跟随即消失 |
| 「重试」 | `PwaMessageActions` | 与「最新」同一行 | 否 | 离线或补齐失败；恢复后消失 |
| 连接提示条 | `PwaConnectionBanner` | 主区提示区 `.pwa-main-notices` | 是，推开下方会话 | 断线超过 10 秒；恢复后消失（随后由 Toast 提示已恢复） |
| 局部错误条 | `PwaStatusError` | 主区提示区 | 是 | 会话或历史出现局部错误；用户关闭或切换会话后消失 |
| 运行时提示条 | `service-worker-register.tsx` 的 Alert（经 Portal 放入提示区槽位） | 主区提示区；无工作区时在应用壳顶层 | 是 | 安装提示、浏览器不支持；用户关闭或条件消失后移除 |

**不在范围**：Toast（Mantine Notifications 已按 `toast` token 进出）、Modal、Popover、Menu、Drawer、骨架与加载提示（另有延迟显示规则）。

## 3. 规范草案（确认后写入 DESIGN「动效」）

新增一类「浮动入口与局部提示」：

1. **出现**：淡入；不占布局的浮动入口另从下方 `--pwa-overlay-shift`（8px，乘 `--pwa-motion-shift`）移到原位。时长 `--pwa-duration-toast`（180ms），进入曲线。
2. **消失**：淡出；浮动入口同时向下移回 8px。时长 `--pwa-duration-fade`（120ms），退出曲线。离开期间不可点击、不可聚焦，也不再被读屏重复播报。
3. **占布局的提示条**：高度一次到位，只淡化，不位移、不做高度过渡。出现时先占位再淡入；消失时先淡出再收起占位。理由见第 4.2 节。
4. **原位更新**：文字或计数变化（「最新」↔「N 条新输出」、连接中 ↔ 重新连接中）原位替换，不重播进出动画。
5. **中途反向**：出现过程中又要消失（或相反），从当前透明度直接反向，不跳回起点，也不排队播完。
6. **减少动态效果**：沿用全局规则，位移置 0，只保留约 120ms 淡化。

## 4. 方案

### 4.1 不占布局的浮动入口（「最新」「重试」）

- 每个按钮独立进出：「重试」出现时不让「最新」重播动画。
- 位移与透明度用 `transform`／`opacity`，只走合成层，不触发会话列表重排。
- 容器 `.pwa-message-actions` 保持 `pointer-events: none`，离开中的按钮额外 `inert`，防止点到正在消失的「最新」。

### 4.2 占布局的提示条（连接、局部错误、运行时）

它们在 `.pwa-main-notices` 中，出现或消失会改变会话列表的高度。两种做法：

| | B1：高度一次到位，只淡化（建议） | B2：高度过渡 |
| --- | --- | --- |
| 做法 | 出现时占位后淡入；消失时淡出后移除 | 参照折叠用 `grid-template-rows` 过渡高度，内容同时淡化 |
| 会话列表 | 高度只变一次，视口按一次 resize 保持跟随或阅读锚点（现有路径） | 180ms 内逐帧变高，视口每帧处理 resize 与锚点恢复 |
| 风险 | 消失时淡出后内容上移一次 | iOS 上逐帧重算与锚点恢复可能抖动；跟随中贴底会逐帧追 |
| 观感 | 与现在相比只多了淡化 | 更柔和 |

**建议 B1**。B2 要等 B1 上线后，在真机录屏上确认跳动明显再评估，评估需包括视口逐帧 resize 的抖动测试。

### 4.3 共用实现

- 新增 `usePresence(visible)`（`pwa/src/lib/ui/presence.ts`）。它返回是否挂载以及当前阶段：`entering`、`shown` 或 `leaving`。
- 离开时长经 `usePwaMotionDuration("--pwa-duration-fade")` 读取。到时卸载，同时监听 `transitionend` 兜底。
- 出现用 CSS `@starting-style`，不需要额外渲染一帧。项目已在 `timeline-content.css` 使用 `@starting-style`；不支持的浏览器（iOS 17.5 以前）直接显示，属于安全降级。
- 消失用 `data-presence="leaving"` 触发过渡。
- 样式只引用 `--pwa-duration-*` 与 `--pwa-ease-*`，由 `pwa-style-guard` 校验。
- 各组件改动：
  - `PwaMessageActions`：每个按钮各自套 `usePresence`；容器在两个按钮都卸载后再移除。
  - `PwaConnectionBanner`：`pwa-app` 现在按 `connectionBannerKind` 条件渲染，改为在提示区层面套 presence。离开期间保留最后一次的 kind 与文案，避免淡出时文字跳成别的状态。
  - `PwaStatusError`：离开期间保留最后一条消息；关闭按钮在离开时 `inert`。
  - 运行时提示条：现有关闭前的焦点恢复（`restoreFocus`）保持在卸载前执行；离开期间 `inert`。

## 5. 风险与对策

1. **焦点**：焦点在正在离开的元素内（如刚点了错误条的关闭按钮）时，先按现有规则移走焦点，再进入离开阶段；离开元素 `inert`，键盘不会再进入。
2. **读屏**：提示条是 `role="status"` 的活动区域；离开阶段加 `aria-hidden`，避免淡出期间文字变化被再次播报。
3. **既有测试**：不少用例断言消失后元素立即不在 DOM，需改为等待离开完成（`expect.poll`）；时长从 token 读取，测试中可把 `--pwa-duration-fade` 设为 0 以缩短等待，但至少保留一组按真实时长验证。
4. **视口**：B1 下提示条高度只变一次，沿用现有 resize 与锚点恢复路径；补一项「阅读中出现连接提示条，阅读行不动」的回归。
5. **兼容**：`@starting-style` 不支持时出现无动画，消失仍有淡出；不影响功能。

## 6. 分阶段

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| P1 | DESIGN 规范、`usePresence`、「最新」与「重试」 | `usePresence` Node 测试；浏览器测试：出现过程、离开期间不可点、中途反向、减少动态效果、文字更新不重播；样式守卫 |
| P2 | 连接提示条、局部错误条、运行时提示条（B1） | 各自进出与焦点；提示区 Toast 定位（`--pwa-main-notices-bottom`）在离开期间正确；阅读中出现提示条时阅读行不动；`pwa-workspace-layout`、`pwa-app` 相关用例 |
| P3 | 真机验收 | iOS／Android：出现与消失观感、`@starting-style` 降级、减少动态效果 |

预估改动：P1 约 200–300 行，P2 约 300–400 行（均含测试）。

## 7. 已确认

2026-10-27 用户确认：占布局的提示条采用 B1；出现 180ms、消失 120ms；PR #147 合并后在 `feature/261027-floating-notice-motion` 实施。

## 8. 实施记录

### 8.1 实现

- `usePresence(value, same)`（`pwa/src/components/pwa/use-presence.ts`）：value 变为 null 后保留最后的值，等 `--pwa-duration-fade` 后移除；离开中重新出现时直接取消移除。`presenceProps` 给离开中的元素加 `data-presence="leaving"`、`inert` 与 `aria-hidden`。
- 样式：`globals.css` 的 `.pwa-presence`（只淡化）与 `.pwa-presence-float`（另带位移），出现用 `@starting-style`。
- `PwaMessageActions`：「最新」「重试」各自套一层 `.pwa-message-action` 包裹并独立进出，不覆盖按钮自身的颜色过渡；离开时保留最后的未读计数。
- `PwaConnectionBanner` 的 `kind` 改为可为 null，`pwa-app` 始终渲染它；离开时保留断线时的文案。
- `PwaStatusError` 保留离开前的原文；运行时提示条由 `ServiceWorkerRegisterContent` 保留最后的标题与操作，`ServiceWorkerNotice` 新增 `leaving`。关闭前的焦点恢复顺序不变。
- 与方案的差异：没有监听 `transitionend`，只按 token 时长定时移除。时长读取在减少动态效果时同样生效，定时足以覆盖；省去事件冒泡（子元素按钮自身的颜色过渡）带来的误判。

### 8.2 验证（2026-10-27，本地 Linux 容器）

- PWA `typecheck`、`lint`（0 error，4 条既有 warning）、`build` 与样式守卫通过。
- Node 全量 1089 项通过。
- 新增 `floating-presence.browser.test.tsx` 6 项：出现的淡入与位移、离开期间不可命中与读屏隐藏、中途反向与文字原位更新、「重试」出现不重播「最新」、连接提示条淡出保留文案、错误条关闭后不可再点、减少动态效果只淡化不位移。反向验证：去掉离开阶段后其中 4 项失败。
- 新增 `timeline-viewport.integration` 一项：阅读中连接提示条出现与淡出，阅读行保持原位。
- 受影响文件通过：`pwa-app`、`pwa-workspace-layout`、`pwa-notice-layout`、`connection-retry`、`ui-controls`、`composer-autosize`、`history-conversation`、`service-worker-register`（含 production 专项）、`ui-states`。

未覆盖：全量 Browser Mode 与 Linux CI 以 Pull Request 结果为准；P3 真机观感与 iOS 17.5 以前的 `@starting-style` 降级待 staging 验收。
