# 动效规范整理与一致性修复

- 日期：2026-10-27
- 用途：整理 DESIGN 的动效规范，并修复规范与实现之间的不一致；本文不是当前实现说明。
- 项目级状态：见 [ROADMAP](../../ROADMAP.md)，不在本文另设状态表。
- 基线：`main` 的 `a819b6c`（PR #148 已合并）。
- 当前事实来源：[DESIGN「基础层」](../../DESIGN.md#基础层)的「动效」行、[「动效时长」](../../DESIGN.md#动效时长)、[「可访问性与动态效果」](../../DESIGN.md#可访问性与动态效果)。

## 1. 背景

PR #148 给浮动入口与局部提示补上进出规则后，对全项目的动效规范与实现做了一次只读核对。整体执行良好，但规范本身难以维护，并有几处规范缺口和实现偏差。本方案只做整理与修复，除第 4.4 节（Toast 离开时长）外不改变用户看到的效果。

## 2. 核对结果

### 2.1 已经做到的

- 正式 CSS 的过渡与动画只引用 `--pwa-duration-*`／`--pwa-ease-*`，由 `pwa-style-guard` 校验。
- Mantine 的 Modal、Menu、Popover、Drawer、Toast 都显式传入 token 时长与曲线（`pi-reach-theme.ts`、`use-pwa-motion.ts`、`pwa-operation-notifications.tsx`），没有退回 Mantine 默认的 `ease`。
- WAAPI 动画（内容淡入、切换淡出、跟手拖动收尾、图片几何过渡）经 `pwaStandardEasing` 取曲线，时长经 `usePwaMotionDuration`／`readPwaMotionDuration` 读取。
- 减少动态效果：CSS 全局规则（`pwa-theme.css`）把位移置 0、过渡只剩颜色与透明度；脚本侧由 `viewportMotionAllowed`（时间线视口）与 `pwaMotionShiftDisabled`（跟手拖动）判断；无限循环在离屏、页面隐藏时暂停。

### 2.2 问题清单

| # | 类别 | 问题 | 证据 |
| --- | --- | --- | --- |
| Q1 | 规范结构 | 「动效」规则全部写在「基础层」token 表的一个单元格里，约 1100 字、十余条规则；减少动态效果在「可访问性与动态效果」中再写一遍，措辞不同，同一事实有两个来源 | `DESIGN.md` 基础层「动效」行；可访问性第三条 |
| Q2 | 规范缺口与写死数值 | 位移距离没有统一规范：叠层 8px、菜单 4px 是 token，用户消息进入写死 `6px`，折叠收起写死 `-4px` | `pwa-theme.css`；`timeline-content.css` 的 `pwa-user-message-in`；`timeline-row.css` 的 `.pwa-collapse-inner` |
| Q3 | token 职责 | `fade` 同时承担通用淡化、浮动入口消失、减少动态效果时的统一替换值；表中「其余过渡时长统一取此值」与实现不完全一致（`press-in`／`press-out`／`feedback` 未被替换，因按压是位移、反馈本就 120ms，暂无可见影响） | `pwa-theme.css` 减少动态效果块；「动效时长」表 |
| Q4 | 一致性 | 其他「出现／离开」都是离开更快（Modal 180/140、Menu 160/120、折叠 180/140、浮动入口 180/120），只有 Toast 进出同为 180ms | 「动效时长」表；`pwa-operation-notifications.tsx` |
| Q5 | 规范缺口 | 「最新」的平滑滚动使用浏览器原生 `scrollTo({ behavior: "smooth" })`，时长与曲线不受 token 控制，各浏览器差别大；规范未说明这是例外 | `timeline-viewport-layout.ts` 的 `scroll()` |
| Q6 | 实现偏差 | 跟随滚动时钟 `FollowMotionClock` 自己解析 `--pwa-duration-message-in`，曲线读取失败退回 `linear`，没有使用约定的 `readPwaMotionDuration`／`pwaStandardEasing`；守卫只查写死数值，未拦住 | `timeline-follow-motion.ts` |
| Q7 | 规范缺口 | 附件卡片、排队消息面板的增减瞬间完成并改变输入区高度，规范未说明是有意为之 | `attachment-cards.css`、`queued-messages.css` 无过渡 |
| Q8 | 守卫覆盖 | 样式守卫不查 `translate` 中写死的距离；脚本守卫不查脚本自行读取动效 token 的写法 | `pwa-style-guard`、`pwa-script-token-guard` |

## 3. 目标与不改动

**目标**：动效规范只有一个来源、结构可查；位移、时长与曲线全部经 token 和公共函数取值，并由守卫约束。

**不改动**：
- 除 Q4 外，所有现有时长、曲线、位移的取值不变，用户看到的效果不变。
- 覆盖模型、浮动入口与局部提示等已确认的交互规则不变，只调整写法与位置。
- 不为附件卡片、排队消息面板新增动画（见第 4.6 节）。

## 4. 方案

### 4.1 规范结构（Q1）

在「视觉 token」下、「动效时长」之前新增 `### 动效` 小节，把基础层「动效」行的内容按以下顺序拆成条目；基础层表中只保留一句概述并链接到新小节。

| 条目 | 内容 |
| --- | --- |
| 曲线 | 标准、进入、退出三条曲线各自的用途；`linear` 只用于无限循环 |
| 时长 | 只引用 `--pwa-duration-*`，取值与用途见「动效时长」 |
| 位移 | 新增位移 token 表（第 4.2 节） |
| 进出模式 | 覆盖模型（Drawer、设置页）；叠层（Modal、Popover、Menu、Toast）；浮动入口与局部提示；内容切换淡入；输入区内增减即时完成（第 4.6 节）；平滑滚动例外（第 4.5 节） |
| 循环 | 只在前台且可见时运行，离屏、页面隐藏或减少动态效果时暂停，重入不重播 |
| 减少动态效果 | 唯一来源：取消位移、缩放、尺寸过渡与平滑滚动，非循环过渡统一为 `--pwa-duration-reduced`；CSS 与脚本两侧的判断方式 |
| 脚本取值 | 时长经 `usePwaMotionDuration`／`readPwaMotionDuration`，曲线经 `pwaStandardEasing` 等公共函数，不在调用点自行解析 |

「可访问性与动态效果」中的减少动态效果条目改为一句话并链接到新小节，不再复述细节。「动效时长」标题不变，现有链接不受影响。

正文中另有三处写明减少动态效果下的替换时长，4.3 实施后会与实现不符，一并改为引用 `--pwa-duration-reduced` 或链接到新小节：「发送消息与跟随」的「气泡使用 `--pwa-duration-fade`（120ms）纯淡入」、「菜单与弹窗」的「减少动态效果退为 120ms 淡化」、会话内容切换的「减少动态效果时缩短为 `--pwa-duration-fade`」。

### 4.2 位移 token（Q2）

沿用 2 个、新增 2 个位移 token，取值保持现状：

| token | 值 | 用途 |
| --- | --- | --- |
| `--pwa-overlay-shift` | 8px | 居中 Modal、Toast、浮动入口进出（已有） |
| `--pwa-menu-offset` | 4px | 菜单沿锚点方向的位移（已有） |
| `--pwa-message-shift` | 6px | 新发送气泡进入（新增，替换 `pwa-user-message-in` 的写死值） |
| `--pwa-collapse-shift` | 4px | 折叠内容收起时上移（新增，替换 `.pwa-collapse-inner` 的写死值） |
| 自身尺寸 `100%` | — | Drawer、设置页、工具组轮播文字，按元素自身尺寸位移，不另设 token |

所有位移都乘以 `--pwa-motion-shift`，这一点不变。

### 4.3 减少动态效果的时长 token（Q3）

- 新增 `--pwa-duration-reduced: 120ms`，在 `PWA_MOTION_FALLBACK_MS` 中同步回退值。
- 减少动态效果块把**所有**非循环时长（含 `fade`、`press-in`／`press-out`、`feedback`）改为引用它。
- 「动效时长」表的 `fade` 行去掉「减少动态效果时……」，新增 `reduced` 行说明用途。
- 状态展厅慢放（`dev/review-runtime.ts`）的 token 清单改为取自 `PWA_MOTION_FALLBACK_MS`，解析复用 `lib/ui/motion-duration.ts` 的公共函数，不再手写副本。现有手写清单已漏掉 `--pwa-duration-message-in`，改后慢放会同时覆盖它与新增的 token。

这样以后调整通用淡化的时长，不会连带改变减少动态效果下的全部时长。取值仍是 120ms，当前没有可见变化。

### 4.4 Toast 离开时长（Q4）

- 新增 `--pwa-duration-toast-out: 140ms`，与 Modal 离开一致；`toast` 只表示出现。减少动态效果块同步加入 `--pwa-duration-toast-out: var(--pwa-duration-reduced)`，回退值进入 `PWA_MOTION_FALLBACK_MS`（慢放清单随之自动覆盖）。
- `toast` 同时是浮动入口与局部提示的出现时长（`.pwa-presence`），本项不改它们；「动效时长」表的 `toast` 行改为「Toast 出现；浮动入口与局部提示出现」，`toast-out` 行写明只用于 Toast，避免以后只为 Toast 调时长时连带改变浮动入口。
- Mantine Notifications 只接受一个 `transitionDuration`（继续传 `toast`，决定卸载时机），离开阶段的时长由已有的离开状态选择器（`.pwa-operation-notification[style*="--notifications-state-opacity: 0"]`）以 CSS 覆盖；Mantine 以内联样式写入过渡时长，覆盖须加 `!important`，与该选择器现有的离开曲线写法一致。CSS 过渡短于卸载时机，只会更早结束，不会被截断。
- 这是唯一会改变观感的一项。实施时在状态展厅对照 180 与 140 两种离开时长，并在 staging 真机复核；观感不合适时回退为 180ms，并在规范中注明 Toast 是对称的例外。

### 4.5 平滑滚动例外（Q5）

规范中写明：「最新」使用浏览器原生平滑滚动，时长与曲线由浏览器决定，不受 token 控制；距底部超过两屏时先瞬时移到离底部一屏处，避免长距离滚动出现空白帧；减少动态效果时改为瞬时滚动。

不改为自行驱动滚动：收益小，并且 iOS 上自行逐帧写入 `scrollTop` 会和系统惯性争夺位置。

### 4.6 输入区内的增减（Q7）

规范中写明：附件卡片、排队消息面板在输入区内的增加与移除即时完成，不做进出动画。原因：它们与发送时的输入区回缩共用高度，叠加过渡会和发送过程互相干扰。

### 4.7 跟随滚动时钟（Q6）

- `FollowMotionClock` 改为经 `readPwaMotionDuration("--pwa-duration-message-in")` 读取时长、经 `pwaStandardEasing(list)` 读取曲线，删除自行解析与 `linear` 回退。
- `pwaStandardEasing` 目前位于 `components/pwa/use-pwa-motion.ts`，`lib/pwa` 不宜反向依赖组件目录。新建 `lib/ui/motion.ts`，迁入 `pwaStandardEasing` 与同样读取计算样式的 `pwaMotionShiftDisabled`；`motion-duration.ts` 只管时长，原位置改为再导出，现有调用点不改。
- 正常加载样式时行为不变。差异只在读取失败的回退：时长从 0（立即结束）改为回退值 160ms，曲线从 `linear` 改为标准曲线，与其他调用点一致；时长改为从根元素读取，与 `--pwa-duration-*` 只在 `:root` 定义一致。

### 4.8 守卫（Q8）

- `pwa-style-guard`：`translate`／`translateX`／`translateY` 中出现非零 px 字面量即报错；允许 `0`、百分比与 `var()`。已有的例外按现有登记表写明原因。
- `pwa-script-token-guard`：在 `lib/ui/motion-duration.ts` 等公共函数之外出现 `getPropertyValue("--pwa-duration-` 或 `getPropertyValue("--pwa-ease-` 即报错。
- 守卫跳过 `dev/`，慢放工具不在其范围内；它的清单与解析副本由 4.3 改为直接复用公共定义消除，不另设守卫。
- 两条规则都先在当前代码上反向验证：改动前应能拦住 Q2、Q6 的写法。

## 5. 风险与对策

1. **减少动态效果回归**：时长改为引用新 token 后，模拟 `prefers-reduced-motion` 的现有浏览器测试应全部通过：`pwa-motion`、`pwa-controls`、`use-page-transition`、`reader-drag`、`message-send`、`thinking-heading-motion`、`tool-indicator-visibility`、`published-file`、`summary-reader`、`floating-presence`；`pwa-script-token-guard` 校验回退值与主题、表格一致。
2. **守卫误报**：新规则可能命中合理用法（如 `translate(-50%, -50%)` 居中）。百分比本就允许；若有其他合理用法，加入例外登记并写明原因，不放宽规则本身。
3. **文档链接**：新增小节不改动已有标题；`pnpm check:docs` 校验锚点。
4. **Toast 离开时长**：CSS 覆盖依赖 Mantine 在离开阶段写入的内联变量（项目已依赖同一选择器设置退出曲线）。在 `pwa-operation-notifications` 测试中补一项离开阶段的计算时长断言，Mantine 升级若改变写法即可发现。

## 6. 分阶段

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| P1 | 4.1 规范结构，4.2 位移 token，4.3 减少动态效果 token，4.5、4.6 规范说明，4.7 跟随滚动时钟，4.8 守卫 | 样式守卫、脚本守卫、主题对比度守卫；第 5 节列出的减少动态效果测试，以及 `collapse`、`timeline-viewport.integration`、`use-timeline-viewport`；`pnpm check:docs` |
| P2 | 4.4 Toast 离开时长 140ms | 状态展厅对照；`pwa-operation-notifications` 离开时长断言；Toast 相关浏览器测试；staging 真机复核 |

P1 不改变视觉效果，在单独的 `feature/*` 分支以一个 PR 完成，本方案随该 PR 提交；P2 在 P1 合并后另行实施。

## 7. 已确认

2026-10-27 用户确认：

1. 新增 `--pwa-duration-reduced`，不再由 `fade` 兼任减少动态效果的替换时长。
2. Toast 离开时长改为 140ms（`--pwa-duration-toast-out`），实施时经状态展厅对照与真机复核。
3. P1 单独开 `feature/*` 分支、一个 PR 完成；P2 在 P1 合并后实施。

2026-10-27 用户确认方案评审补充的 7 项（DESIGN 散落的替换时长引用、follow clock 回退差异、慢放清单、P2 的减少动态效果与 `!important`、`toast` 共用说明、`lib/ui/motion.ts`、位移 token 表述），并授权实施 P1；P1 在分支 `feature/261027-motion-spec-cleanup` 实施，提交、推送与 Pull Request 另行授权。

## 8. 实施记录

### P1（2026-10-27，分支 `feature/261027-motion-spec-cleanup`，本地未提交）

- 守卫：`pwa-style-guard` 新增 `translate` 距离规则与扫描器自测，`pwa-script-token-guard` 新增动效 token 只经公共函数读取的规则。改动前在原代码上反向验证，分别拦住 `timeline-content.css` 的 `6px`、`timeline-row.css` 的 `-4px`，以及 `timeline-follow-motion.ts` 两处、`use-pwa-motion.ts` 一处自行读取。
- token：`pwa-theme.css` 新增 `--pwa-message-shift`、`--pwa-collapse-shift`、`--pwa-duration-reduced`；减少动态效果块全部改为引用 `reduced`，并补上 `fade`、`press-in/out`、`feedback`；`PWA_MOTION_FALLBACK_MS` 同步。
- 脚本：新建 `lib/ui/motion.ts`（`pwaStandardEasing`、`pwaMotionShiftDisabled`），`use-pwa-motion.ts` 再导出；`motion-duration.ts` 拆出 `resolvePwaMotionDuration`；`FollowMotionClock` 改用公共函数；慢放工具改为取自 `PWA_MOTION_FALLBACK_MS` 并复用解析函数。
- 文档：DESIGN 新增「动效」小节；基础层「动效」行、「可访问性与动态效果」及正文三处替换时长引用改为链接；「动效时长」表新增 `reduced` 行；守卫说明补两条规则。
- 与方案的差异：减少动态效果下 `press-in` 由 90ms 变为 120ms。此时位移已取消，只影响按下时底色、边框的过渡，肉眼难以分辨；慢放现在也覆盖 `message-in`（原清单遗漏）。
- 验证：PWA Node 全量 86 个文件 / 1092 项通过（含守卫）；Browser Mode 定向 15 个文件 / 320 项通过（第 5 节列出的减少动态效果测试，以及 `collapse`、`timeline-viewport.integration`、`use-timeline-viewport`、`ui-review-stage-a`、`ui-states`）；`pnpm typecheck`、`pnpm build`、`pnpm check:docs` 通过；`pnpm lint` 0 错误，4 条警告都在本次未改动的文件中。CI 全量结果以 Pull Request 为准。

P1 已随 PR #149 合并。

### P2（2026-10-27，分支 `feature/261027-toast-exit-motion`）

- token：新增 `--pwa-duration-toast-out: 140ms`，减少动态效果块改为引用 `reduced`，回退值进入 `PWA_MOTION_FALLBACK_MS`，状态展厅慢放随之自动覆盖。
- 实现：`globals.css` 的 Toast 离开状态选择器加 `transition-duration: var(--pwa-duration-toast-out) !important`；Mantine 仍以 `toast`（180ms）决定卸载时机。
- 文档：「动效时长」表的 `toast` 行改为 `toast` / `toast-out`，注明 `toast` 与浮动入口共用、`toast-out` 只用于 Toast。
- 与方案的差异：离开时长断言放在已有的 `pwa-motion` 测试「uses token timing and distinct Toast exit easing」中（原断言 180 改为 140，减少动态效果仍为 120），不另在 `pwa-operation-notifications` 测试中重复。
- 验证：守卫 5 个文件 / 46 项通过；Browser Mode `pwa-motion`、`pwa-operation-notifications`、`ui-state-surfaces`、`ui-states` 共 4 个文件 / 33 项通过；`pnpm typecheck` 通过，`pnpm lint` 0 错误（4 条警告都在本次未改动的文件中）。
- 未覆盖：180 与 140 两种离开时长的观感对照需要人工在状态展厅（可用 0.25× 慢放）与 staging 真机上复核；不合适时按 4.4 回退为 180ms，并在规范中注明 Toast 是对称的例外。
