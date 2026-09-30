# 品牌刷新实现缺口修正

本方案承接 [Pi Reach 品牌刷新方案](20260925-pi-reach-brand-refresh.md) 阶段 7。核对基线为 2026-09-29 的 `main`；本文列出实现偏差、待核对项与修正步骤，先完成必要的前置确认，再按步骤实施。规则以品牌刷新方案为准，本文不另立设计规则；需要调整规则的地方单独标出，待用户决定后先回写品牌刷新方案，再改代码与 [DESIGN](../../DESIGN.md)。事项状态仍只在 [ROADMAP](../../ROADMAP.md) 的「Pi Reach 品牌刷新」一行维护。下文代码行号对应上述基线，实施时以选择器、符号与实际消费者重新定位。

## 核对依据

- **方法与限制**：对照品牌刷新方案，在 `pwa/src` 中检索色值、尺寸、时长、曲线、文案与流程实现。初次 CSS 扫描形成了步骤 5 的候选清单，但未完整覆盖变量、`font` 简写及最终生效样式；清单不能视为全部可见缺陷，实施前须补齐消费者与级联核验。
- **已核对部分**：57 个方案色值均存在于 `pwa-theme.css`，组件 CSS 的颜色使用 token，圆角使用 token 或全圆／贴边值；动效曲线与时长 token 已定义，Lucide 线宽为 `1.8`，布局断点为 `768px`，字体为系统栈。另已核对设置页路由与 nginx／Service Worker 回退，Toast 自动消失、暂停、替换与 `aria-live`，断线 10 秒提示条，历史每次 20 条，后台完成提醒圆点，配对自动提交与错误码文案，工具阅读器 `pushState`、12 行预览与 `720px`，以及阶段 7 已列出的输入区、发送／停止互斥、「/」命令入口与 `custom` 事件隐藏。token 存在不代表全部消费者已接入；动效缺口与待核对范围见步骤 3。
- **原核对记录中的本机验证**：PWA 类型检查、lint，Node 测试 368 项、浏览器组件测试 380 项（11 项跳过）、生产 Service Worker 测试 18 项（1 项跳过），Extension 323 项、协议 13 项均通过。全量 `pnpm test` 的 workspace 并发执行中，Relay 黑盒用例 `removes a disconnected host pairing offer` 失败 1 次；单独运行 `pnpm test:relay` 连续两次 46/46 通过。这只能说明失败未稳定复现，不能证明负载是根因或排除与本轮变更的关联；见步骤 7。本次文档修订未重跑这些测试。

## 通用规则

- 先完成下方前置确认，再逐步实施；每个实现步骤单独验证，完成后进入下一步。步骤 7 的 Relay 竞态经用户确认在本批一并修复；提交与推送各自取得用户授权。
- 改动全局样式或布局时，在 `767`／`768px` 两侧及 `390`、`1440px` 宽度下检查浅色与深色；键盘与输入区另覆盖短窗口及手机横屏。涉及 Drawer、Modal、Menu、Popover 时按项目 overlay 验证技能验收。
- 行为或样式变更执行受影响的 `typecheck`、`lint`、测试与 `git diff --check`；纯文档修正核对事实、链接与 diff，不运行无关业务测试。最终冻结的 PWA 改动还须通过生产构建 `pnpm --filter pwa build`，核对入口、样式与 Service Worker 产物；后续 diff 变化只重跑受影响验证。

### 执行前确认

步骤 5 分为「核对与决策」和「样式实施」：会影响前序工作的决定先确认，批量样式调整仍在步骤 5 执行，不要求步骤 2 完成后才讨论行高。

- **步骤 2 已确认原则**：输入区使用 `--pwa-leading-ui`（`1.4`）；允许在可用高度不足时少于 6 行就内部滚动，优先保留消息阅读区和操作按钮。具体触发条件、保留空间与验收边界以下方已确认的集中决策清单为准，不直接沿用旧像素上限。
- **步骤 3 已确认范围**：工具阅读器及本方案列出的 Modal、Toast、Menu 一并纳入本轮核对和修正，遵循已确认的品牌动效规则；不能把时长 token 存在当作消费者已经合规。
- **步骤 5 已确认流程**：先区分有效样式、被覆盖规则、无消费者遗留与候选例外，再集中确认调整值或例外，之后修改样式。仅数值相同不能作为复用同一 token 的依据。

### 集中决策清单（已确认，实施依据）

用户已确认下列具体数值与例外，可以据此实施；若发现空间预算无法满足或需要扩大范围，先返回冲突，不静默改规则。源码核对已覆盖本方案涉及的样式文件、Mantine 配置与生产消费者，静态级联分析不能代替后续 computed style 和实屏验收。

| 项目 | 建议采用的边界 |
| --- | --- |
| 输入区短窗口上限 | 不按固定 `600px`／`450px` 视口阈值切换。按实际可用高度，扣除顶栏、通知、队列、附件及输入区非文字部分后计算 textarea 上限；高度充足为 6 个视觉行，不足时提前滚动，textarea 不低于 `44px`。为消息区至少保留一行正文和上下各 `8px` 留白（按当前 `14px/1.65` 约 `40px`）。若连这些最小区块都无法容纳，记录为布局冲突并先确认进一步取舍，不通过隐藏内容或缩小触控目标强行通过 |
| 已列间距的歧义值 | 加载说明上方 `14→16`；电脑卡片间距与状态 gap `5→4`；标签上下 `3→2`；导航／电脑入口文字 gap `1→2`；短窗口连接提示 gap `7→8`；其余沿步骤 5.2 的单一建议值。重命名输入框按最终盒模型保证 `44px`，不指定机械的 `11→10` |
| 字号 | 保留侧栏列表 `13px` 和表单选项标签 `13px/600`；弹窗与配对正文、加载说明、提示标题、Toast、队列消息、只读说明、压缩／分支摘要、思考标题及「查看全部」改为 `14px`；图片省略说明与配对连接状态为 `12px`；阅读器命令标题和行内代码为等宽 `12.5px` |
| 行高 | 输入区、标题、按钮、菜单、状态与短说明使用 `--pwa-leading-ui`；弹窗／配对正文、队列消息、压缩／分支摘要使用 `--pwa-leading-body`；代码和命令使用 `--pwa-leading-code`。队列计数标签 `1→1.4`，固定高度与居中布局保持。读取实际继承值后消除非代码文本误用代码行高，不只替换已列字面量 |
| 特殊尺寸与细档 | 保留消息区 `88px` 避让、复制按钮 `52px` 避让、空状态顶部 `clamp(..., 260px)`，分别按用途验收，不复用侧栏宽度变量。收起侧栏后的标题左留白建议由 `56px` 恢复主区 gutter。行内代码／命令胶囊的 `1px` 纵向内边距和工具箭头 `1px` 对齐补偿登记为局部排版例外；普通消息／错误／只读说明块的 `10px` 内边距改为 `12px`。既定工具行 `6px` 间距、紧凑列表／标签／输入区的细档保持 |
| 无消费者样式 | 清理经复核无生产消费者的 `.pwa-settings-note`、`.pwa-mobile-menu-panel`；保留共享规则中的 `.pwa-composer-menu-panel`，不整条删除逗号选择器 |
| 叠层时长 | Modal 常规 `180／140ms`、阅读器 `240／200ms`、Toast 保留当前常规 `180ms`，均接入 token；本轮 Menu 建议统一采用现有 `120ms` 淡化 token。减少动态效果统一 `120ms`、无位移、标准曲线；正常进入／退出分别使用相应曲线，既有导航／电脑选择时长不顺手更改 |

补充核对：`queued-messages.css:20` 的队列标题仍为 `12px/1.3`；`timeline-row.css:13` 的思考／工具标题使用 `13px` token；`tool-reader.css:62–64` 的空态和状态说明使用代码行高，`:76` 的命令标题使用 `13px` token。这些消费者纳入上述字号／行高分组。`workspace-navigation.css:331` 已把移动端状态 gap 覆盖为 `4px`，`5→4` 主要影响桌面；确认／重命名按钮组还受 Mantine `Group gap="xs"` 影响，实施时检查最终级联，避免改了无效声明就宣称完成。

## 步骤 1：更正长期文档中的旧字体表述

Fontsource 与 `fonts.css` 已在阶段 2 移除，但以下文档仍按旧实现描述，违反阶段 7「其余长期文档无旧 token 表述」：

- `docs/ARCHITECTURE.md:43`：「预缓存……包含脚本、样式及本地字体」「字体通过 Fontsource 保留字重和字集」。
- `pwa/README.md:21`：「locally bundled Fontsource fonts」。

**做法**：改为「界面使用系统字体栈，不打包或下载网络字体」，与 `pwa/AGENTS.md` 现有表述一致。预缓存核验同时检查 `pwa/vite.config.ts` 的资源收集配置与当前生产构建产物：`sw.ts` 只有 `self.__SW_MANIFEST` 注入占位符，实际清单生成在 `dist/sw.js` 中。配置仍允许收集 `woff`／`woff2`，不能仅凭扩展名存在或占位符内容判断是否打包了字体，也不据此自动删除构建配置。

**验收**：全仓（不含历史方案与 ADR）检索 `Fontsource`、`本地字体` 无当前事实表述；核对可追溯到当前源码的 `dist/` 资源与 `dist/sw.js` 预缓存项无字体文件，没有相应产物时先构建再核验；`git diff --check`。不运行无关业务测试。

## 步骤 2：输入区增高上限改为 6 行

方案「布局 · 移动键盘」要求输入区随内容增高至 6 行后内部滚动。当前 `message-composer.tsx:161` 把高度上限写死为 `120px`；按 `16px`／`1.5` 行高及上下内边距 `10px` 计算只能显示约 4 行。限制不只在 JS：`globals.css:231` 同样设置 `max-height: 120px`；`:485` 的短窗口规则为 `min(120px, 20dvh)`，`:488`、`:493` 在局部错误提示出现时进一步压到不超过 `96px` 或固定 `44px`。

**前置条件**：行高 `1.4`、允许短窗口提前滚动及集中决策清单中的空间预算均已确认。正常高度下最多 6 行，不能用删除所有保护规则的方式满足六行测试。

**做法**：

- 同时调整 `message-composer.tsx` 的自动增高逻辑与 `globals.css` 的普通／短窗口上限，避免 JS 放宽后仍被 CSS 截断。
- 六行上限按实际行高、内边距和盒模型计算，不另维护一个固定像素值；采用已确认的 `1.4` 时，当前无边框 textarea 的上限约为 `16 × 1.4 × 6 + 20 = 154.4px`。以视觉换行后的行数为准，不只统计换行符。
- 短窗口提前滚动已获准，按已确认的可用高度预算限制实际上限；桌面短窗口与移动键盘场景使用同一原则，步骤 4 接入视口补偿后重新验证。

**验收**：浏览器组件测试在高度充足时断言 1–6 行不溢出、第 7 行起内部滚动且高度不再增长；覆盖显式换行、窄屏自动换行、删除内容后回缩，以及宽度变化后的重算。短窗口、键盘弹出及局部错误提示场景按已确认策略验收，检查输入区操作仍可用、消息区未被挤没；只有批准提前滚动的例外后，才不要求这些场景完整显示 6 行。滚动与高度断言允许浏览器亚像素取整误差，不能只检查内联 `height`。

## 步骤 3：阅读器及其他叠层接入统一动效 token

`tool-reader.tsx:104` 写死 `duration: 240, exitDuration: 200`，退出也使用进入曲线；全局「减少动态效果」规则只为移动导航与电脑选择 Drawer 取消了 Mantine 的内联位移，没有覆盖阅读器。移动导航、电脑选择与设置页等已使用 `usePwaMotionDuration`，但不能据此认定所有叠层已接入：

| 待核对实现 | 当前值 | 核对重点 |
| --- | --- | --- |
| `pwa/src/lib/ui/pi-reach-theme.ts:80` 的 Modal 默认值 | 硬编码 `180／140ms` | 常规时长与方案一致，但未读取 token；减少动态效果下的时长与卸载需核对 |
| `pwa-operation-notifications.tsx:60` | `transitionDuration={180}` | Toast 常规与减少动态效果的实际时长、进入／退出曲线 |
| `session-actions-menu.tsx:155`、`message-composer.tsx:36、295`、`workspace-device-control.tsx:50`（电脑操作菜单）的 Menu | `duration: 0` | 即时开关是否符合既定动效规则，还是需要单独修正 |

以上叠层已确认纳入本轮核对和修正，具体时长按已确认的集中决策清单实施。不得以阅读器通过代替全部已纳入叠层的动效、退出卸载与焦点验收。

**阅读器做法**：

- 进入／退出时长分别读取 `--pwa-duration-reader-in`／`--pwa-duration-reader-out`，常规进入／退出分别使用 `--pwa-ease-enter`／`--pwa-ease-exit`；减少动态效果时沿用全局标准曲线。
- 在 `pwa-theme.css` 的 `prefers-reduced-motion` 规则中把阅读器 Drawer 加入取消位移的选择器，减少动态效果时只做 `120ms` 淡化。
- 核对阅读器退出后的卸载与焦点返回「查看全部」按钮不受时长变化影响。

**验收**：浏览器组件测试检查常规 `240／200ms` 与减少动态效果 `120ms` 的进入、退出时长和曲线；减少动态效果下实际无位移且仍有透明度过渡。按 overlay 验证技能检查关闭、快速重开、卸载、回焦与会话阅读位置，不能只断言 token 存在。

## 步骤 4：移动键盘适配

方案「布局 · 移动键盘」要求：输入区贴在键盘上方、顶栏保持可见；弹出键盘前在底部则保持贴底，正在回看历史则保持阅读位置；消息列表禁用下拉刷新与滚动穿透；以 `interactive-widget=resizes-content` 配合 `visualViewport` 兜底实现。当前 `index.html` 的 viewport 未设置 `interactive-widget`，代码中也没有 `visualViewport` 处理，DESIGN 同样没有记录这条规则。滚动穿透部分已由 `overscroll-behavior` 实现。

**做法**：

1. `index.html` 的 viewport 增加 `interactive-widget=resizes-content`，在支持该设置的浏览器中让软键盘缩小布局视口；不将其视为所有浏览器均已适配。
2. 新增可见视口兜底钩子，按软键盘遮挡与布局视口是否已缩小决定是否补偿，不仅以 `<768px` 开关，也不只按浏览器名称判断。原方案规定手机横屏（如 `844×390`）与 iPad 竖屏进入桌面布局，这些场景仍需键盘适配，不改变布局断点。
3. 高度变量由实际高度所有者 `.pwa-app-shell` 消费，而非只给内层工作区设置 `height`：当前 `globals.css:104–111` 中 shell 为 `100dvh`，其子级 `.pwa-root` 为 `flex: 1 1 0; height: auto`。无补偿时保留 `100dvh` 回退，并核对运行时提示槽、设置页和 Portal 叠层的可用区域，避免重复扣减高度。
4. 同时处理 `visualViewport` 的尺寸与 `offsetTop`／滚动变化，抵消聚焦时的整体上推；区分键盘遮挡与浏览器工具栏等变化，不把所有视口缩小都当作键盘。键盘收起、旋转、布局切换及组件卸载时恢复高度／偏移并清理监听；API 不可用时保留原布局。
5. 复用 `use-timeline-viewport` 已有的 `ResizeObserver`、贴底与阅读锚点处理，先验证容器尺寸变化能否直接触发既有逻辑，仅在证据表明不足时补接入，不另写一套滚动规则。同步复验步骤 2 的短窗口策略。
6. 现有 viewport 中的 `maximum-scale=1, user-scalable=no` 保持不变，本步骤不改缩放策略。
7. 落地后把已验证的键盘与视口规则写入 DESIGN 的布局段落。

**验收**：组件测试使用实际 shell 与时间线，模拟布局视口已缩小／未缩小、`visualViewport` 高度及 `offsetTop` 变化，检查容器实际边界、底部跟随和回看锚点不跳动，而不只断言 CSS 变量。覆盖键盘开关、旋转、跨 `768px` 断点、无 API 回退、监听清理，并验证顶栏与输入区操作可见、设置页与叠层未新增溢出。Playwright 补充手机竖屏、`844×390` 横屏和平板宽度回归；最终键盘效果仍须步骤 8 的 iOS／Android 真机确认，本步骤不宣称真机通过。

## 步骤 5：间距、行高与字号档位核对

方案「基础 token」规定：间距档位 `4 · 8 · 12 · 16 · 20 · 24 · 32 · 48`，细档 `2`、`6`、`10` 仅用于紧凑列表、标签和输入区内边距；行高按语义分为正文 `1.65`、界面文字 `1.4`、代码 `1.55`，不能只检查数值落在三档内；字号阶梯中 `13px` 用于侧栏列表，「表单输入」另允许标签 `13px`／`600`。以下是候选清单与建议，不代表扫描已经穷尽或所有声明都实际生效；**有效样式逐项由用户决定「调整」还是「登记例外」**，决定后先回写品牌刷新方案，再改代码。输入区行高与短窗口策略在步骤 2 前确认，其余样式在本步骤实施。

核对先于修改：

1. 扫描 `pwa/src` 的 CSS、组件内联样式和 Mantine 配置，包含 `font` 简写、`var(...)` 引用及媒体查询；解析 `--pwa-text-list` 等变量的实际值，不仅检索字面量 `13px`。区分间距、控件尺寸、定位补偿和纯图形尺寸。
2. 为每项标明消费者与最终生效规则，分为「有效样式」「被覆盖规则」「无消费者遗留」「候选例外」。共享逗号选择器逐个检查，不能因其中一个无消费者而改删整个规则。
3. `.pwa-settings-note`（`globals.css:324–325`）目前在 `pwa/src` 中只找到 CSS 定义，未找到页面消费者；其 gap `9px`、padding `13px`、行高 `1.5` 不作为已确认的可见缺陷。实施前复核动态 class 等访问；确认无消费者后单独决定是否清理，不为它新增设计例外。
4. 对实际生效的项确认调整值或例外，再改样式和测试。例外须说明用途、适用场景与限制，不把所有遗留值直接登记为例外。
5. 行高调整时引用 `pwa-theme.css` 已有的 `--pwa-leading-body`／`--pwa-leading-ui`／`--pwa-leading-code`（`1.65`／`1.4`／`1.55`，已有消费者如 Toast 文字），不再写数字字面量；按文字语义选择 token，不能因数值相同而随意互换。

### 5.1 布局与定位尺寸（先确认用途，再决定是否登记例外）

| 位置 | 取值 | 用途 | 建议 |
| --- | --- | --- | --- |
| `globals.css:187` `.pwa-message-list` | 底部 `88px` 与 `scroll-padding-bottom` | 为「最新」入口预留 | 例外：由布局推导的尺寸 |
| `workspace-shell.css:105` 侧栏收起时 `.pwa-title-bar` | `padding-left: 56px` | 收起态标题左侧为同一行的展开按钮让位（`8 + 44 + 4`） | 例外：由按钮推导的尺寸（2026-09-29 按钮移至标题区后确认，见 [ADR-20260929](../../adr/20260929-sidebar-toggle-placement.md)） |
| `workspace-shell.css:126` `.pwa-workspace-state` | `clamp(48px, 24dvh, 260px)` 的上限 `260px` | 空状态顶部留白的最大值，与侧栏宽度无语义关系 | 按空状态垂直位置验收；保留时登记用途，不复用侧栏宽度变量 |
| `timeline-content.css:55` `.pwa-code-block pre` | 右侧 `52px` | 给复制按钮让位 | 例外 |

### 5.2 间距（建议调整到最近档位）

| 位置 | 当前 | 建议 |
| --- | --- | --- |
| `globals.css:251–252` `.pwa-composer-menu-panel button` 与 `.pwa-mobile-menu-panel button` | gap `9`，左右 `11` | `8`／`12`；前者有附件菜单消费者；后者在 `pwa/src` 组件与库代码中未找到消费者，按「无消费者遗留」处理（同 `.pwa-settings-note`），实施前复核动态 class 后单独决定是否清理 |
| `globals.css:257–258` `.pwa-command-row`、`.pwa-command-back` | gap `9`，上下 `7` | `8`／`6` |
| `globals.css:333` `.pwa-confirm-title` | 上 `7` | `8` |
| `globals.css:335` `.pwa-confirm-description` | 上 `18` | `16` |
| `globals.css:338` `.pwa-rename-field input` | 上下 `11` | 结合通用 `.pwa-input` 覆盖后的字号、行高、边框与最小高度，按单行高 `44` 重算；不只把 `11` 换成 `10` |
| `globals.css:342`、`:531` `.pwa-confirm-actions` | gap `9`，上 `22`／移动 `18` | `8`，`24`／`16` |
| `globals.css:388` `.pwa-startup-icon` | 下 `18` | `16` |
| `globals.css:392` `.pwa-startup-actions` | gap `9`，上 `22` | `8`，`24` |
| `globals.css:396` `.pwa-loading p` | `14` | `12` 或 `16` |
| `globals.css:434` `.pwa-runtime-notice` | 左 `14` | `12` |
| `globals.css:452` `.pwa-toast` | gap `14`，内边距 `14` | `12`／`12` |
| `globals.css:477`、`:515` 移动连接提示条 | gap `7`，内边距 `9 11` | `6` 或 `8`，`8 12` |
| `globals.css:508` 移动 `.pwa-settings-inner` | 底 `40` | `48`（与桌面一致） |
| `globals.css:514` `.pwa-startup-card` | `25` | `24` |
| `workspace-shell.css:66–67` 会话与历史列表的 `.pwa-nav-link-body` | gap `1` | `2` 或登记紧凑排版例外，待定 |
| `workspace-navigation.css:19` `.pwa-device-trigger-copy` | gap `1` | `2` 或登记紧凑排版例外，待定 |
| `workspace-navigation.css:72` `.pwa-device-panel-empty` | 上下 `18` | `16` |
| `workspace-navigation.css:88` `.pwa-peer-card` | 下 `5` | `4` 或 `6` |
| `workspace-navigation.css:109` `.pwa-computer-select` | `9 7` | `8 6`（紧凑列表细档） |
| `workspace-navigation.css:176` `.pwa-peer-presence` | gap `5` | `4` 或 `6` |
| `workspace-navigation.css:194` `.pwa-current-label` | 上下 `3` | `2` 或 `4`（标签细档） |
| `workspace-navigation.css:301` `.pwa-device-drawer-head` | 左 `18` | `16` |

### 5.3 行高（按文字语义核对三档，不只匹配数值）

| 位置 | 当前 | 建议 |
| --- | --- | --- |
| `globals.css:231` 输入区文字 | `1.5` | 已确认改用界面行高 token `1.4`，与六行及短窗口上限一并实施 |
| `globals.css:258、268` 命令行、返回入口与命令文字的 `font` 简写 | `1.3` | `1.4`；同时覆盖行容器与文字节点 |
| `globals.css:326、346、369` 重置说明、错误、配对提示 | `1.5` | `1.4` |
| `globals.css:289、335、364` 设置分区说明、弹窗说明、配对说明 | `1.55` | 非代码文本，按界面 `1.4` 或正文 `1.65` 确认 |
| `timeline-content.css:45` 行内代码的 `font` 简写 | `0.9em/1.5` | 核对行内代码字号与行高是否登记例外；不据此改动代码块的 `12.5px/1.55` |
| `globals.css:333`、`:389` 确认弹窗标题、启动页标题 | `1.25` | `1.4` |
| `globals.css:414`、`:421`、`:441`、`:448` 连接提示条、运行时提示 | `1.45` | `1.4` |
| `globals.css:445` 运行时提示标题 | `1.35` | `1.4` |
| `globals.css:476`、`:479` 移动连接提示条 | `1.2` | `1.4`，同时复核提示条高度 |
| `queued-messages.css:36` 队列计数标签 | `1` | 核对标签实际高度，再决定 `1.4` 或例外 |
| `queued-messages.css:71`、`:80`、`:89` 待发送消息状态、说明、正文 | `1.35`／`1.45` | 状态与说明建议 `1.4`；正文结合用户消息预览语义确认 |
| `tool-reader.css:67` `.pwa-image-omitted` | `1.5` | `1.4` 或按说明正文确认 |

### 5.4 字号 `13px`

| 位置 | 用途 | 建议 |
| --- | --- | --- |
| `workspace-navigation.css:31` 电脑选择入口名称、`:159` 电脑列表名称 | 侧栏列表 | 符合规则，保留 |
| `globals.css:305` `.pwa-appearance-copy strong` | 设置选项标题 | 按表单标签保留 `13px`／`600`，或改 `14px`，待定 |
| `globals.css:335` `.pwa-rename-description`、`.pwa-confirm-description` | 弹窗正文 | `14px` |
| `globals.css:395` `.pwa-loading` | 加载说明 | `14px`（空状态说明同级） |
| `globals.css:445` `.pwa-runtime-notice-title` | 提示标题 | `14px`／`600` |
| `queued-messages.css:88` 待发送消息正文 | 用户消息预览 | `14px`（与消息正文一致）或 `12px`，待定 |
| `globals.css:364、371` `.pwa-pairing-description`、`.pwa-pairing-status` | 配对说明与连接状态，使用 `--pwa-text-list` | 不是侧栏列表；按正文／状态语义确认字号 |
| `globals.css:460` `.pwa-operation-notification` | Toast 文字，通过 `font` 引用 `--pwa-text-list` | 确认字号或登记例外，不因使用 token 自动认定合规 |
| `tool-reader.css:31、67` `.pwa-tool-details-button`、`.pwa-image-omitted` | 「查看全部」按钮与图片省略说明，使用 `--pwa-text-list` | 按按钮／说明语义确认字号 |
| `workspace-shell.css:169`、`timeline-content.css:12` | 移动只读说明条、压缩与分支摘要，使用 `--pwa-text-list` | 按说明／正文语义确认字号 |

**验收**：逐项修改后按「通用规则」的宽度与明暗检查截图和 computed style，覆盖中文／英文长文案；登记为例外的项写入品牌刷新方案与 DESIGN。再次按上述扫描范围检查变量、简写、内联样式、媒体查询及消费者，每个候选均有明确处置。不能把「按表改完」或「字面量搜索无匹配」当作无遗漏；未处理项保留为待办，不宣称全量合规。无消费者样式的清理与有效样式调整分别验收。

## 步骤 6：清理废弃文案

以下文案键在界面代码中已无使用（中英文字典各一份），为改版前遗留：`connection.localOnly`、`navigation.noPiOnComputer`、`navigation.itemCount`、`navigation.noComputerSelected`、`navigation.chooseComputerHint`、`navigation.moreOptions`、`pwaNotice.updateBody`、`timeline.emptyTitle`、`timeline.emptyLive`。

**做法**：删除前再确认无动态键访问与测试依赖；删除后中英文字典结构保持一致。

**验收**：`messages.node.test.ts` 与类型检查通过。

## 步骤 7：Relay 未稳定复现的失败（用户确认一并修复）

原验证记录显示：`relay` 黑盒用例 `removes a disconnected host pairing offer` 在全量 `pnpm test` 的 workspace 并发执行中失败 1 次，单独 `pnpm test:relay` 连续两次通过。测试位于 `relay/test/blackbox.test.mjs:675`。

根因、修复与验证见「实施记录」步骤 7。原失败日志与断言文本未保留，根因依据症状复现而非原始日志；该修复是 Relay 行为变更（host socket 已关闭但尚未注销时，pairing 码不再解析成功），与品牌刷新验收分别记录，不作为其完成条件。

## 步骤 8：实屏与真机验收

步骤 1–6 完成后，按品牌刷新方案「资产与验收」第 2 条和阶段 7 执行，可与 [PWA 加固与真实设备验收](20260824-pwa-hardening.md) 合并执行，证据分别记录：

- 明暗 × 桌面／移动实屏：配对，0／1／多个在线 Pi，历史，运行与错误，工具／代码，设置与确认弹窗；动效联动与工具长输出的滚动、焦点、快速切换。
- iOS 与 Android 真机：键盘（步骤 4，含竖屏、手机横屏、平板宽度、旋转与收起后的恢复）、安全区（含横屏左右留白）、图标 16／32px 清晰度与安装图标 maskable 裁剪、已安装 PWA 打开 `/app/settings`。记录设备、系统／浏览器版本、浏览器或 standalone 模式与实际结果；缺少设备的场景保留未覆盖，不用桌面移动视口替代。
- 实现不符合既定规则时按规则修复；若验收证明规则或数值本身需要调整，先取得确认并回写品牌刷新方案，再改代码与 DESIGN。

真机环境、设备与测试 Pi 由用户确认后再开始。

## 实施记录（2026-09-29，未提交工作区）

本记录覆盖步骤 1–7 的实施；步骤 8 未开始。

| 步骤 | 结果 |
| --- | --- |
| 1 | `ARCHITECTURE.md`、`pwa/README.md` 已改为系统字体栈；全仓检索（不含历史方案与 ADR）无当前事实性的 Fontsource／本地字体表述。生产构建后 `dist/` 无字体文件，`dist/sw.js` 预缓存 9 项无字体 |
| 2 | 输入区行高改用 `--pwa-leading-ui`，上限按视觉行与可用高度计算（`use-composer-autosize.ts`、`globals.css`），短窗口提前内部滚动，最低 `44px`；空间无法容纳时标记 `data-composer-budget="conflict"`。`composer-viewport.browser.test.tsx` 覆盖 1–6 行、第 7 行起滚动、回缩、宽度重算、附件短窗口与键盘场景 |
| 3 | 阅读器、Modal、Toast、Menu 读取 `--pwa-duration-*` 与进入／退出曲线 token（`use-pwa-motion.ts`）；减少动态效果统一 `120ms` 无位移。Menu 由即时开关改为 `120ms` 淡化，业务动作在退出结束后交接，`pwa-app.browser.test.tsx` 相应改为等待请求发出。`pwa-motion.browser.test.tsx` 检查时长与曲线 |
| 4 | `index.html` viewport 增加 `interactive-widget=resizes-content`；`use-keyboard-viewport.ts` 兜底（仅缩小 visual viewport 时补偿、缩放不视为键盘、清理监听）。验证中发现键盘收起时短窗口密度切换会改变消息区内边距，ResizeObserver 无法感知，且尺寸钳制的滚动事件晚于布局变化到达，被当作用户上滑而停止跟随（768×1024 下离底 96px）。补接：`use-timeline-viewport.ts` 导出 `TIMELINE_GEOMETRY_EVENT`，跟随中同步贴底并登记为程序滚动，否则沿用锚点恢复；键盘钩子的密度切换与输入区预算切换派发该事件。键盘与输入区规则已写入 DESIGN |
| 5 | CSS 中不再存在表内列出的非档位间距值、字面量行高（`font: inherit` 除外）；`.pwa-settings-note`、`.pwa-mobile-menu-panel` 已无定义；局部尺寸例外与字号语义已写入品牌刷新方案与 DESIGN。Markdown 表格经用户决定改为 `14px`（`timeline-content.css` 使用 `--pwa-text-body`），`message-list.browser.test.tsx` 期望值同步 |
| 6 | 9 个废弃文案键已从中英文字典删除，`src` 中无引用，`messages.node.test.ts` 通过 |
| 7 | 根因（重现得出）：Relay 在服务端 socket `close` 回调中才注销 host 并清理 offer（`registry.unregisterHost`），而 `resolvePairingCode` 只核对 `connId` 与 `runtimeInstanceId`；host 的 close 帧已到达、socket 不再 OPEN 但 close 事件尚未触发的窗口内，owner 的 `resolve` 仍会得到 `pairing_target`（预期 `unknown_code`）。原用例以客户端 close 作同步点，CPU 高负载下命中该窗口：探针 1500 次中 84 次（约 5.6%）。原失败日志未保留，原断言文本未核对，结论依据症状复现。修正（用户确认 Relay 也要改）：`Outbound` 增加 `isOpen()`（`registry.ts`、`transport.ts`、`server.ts`），`resolvePairingCode` 遇到 host socket 已非 OPEN 时清理该端点 offer 并回复 `unknown_code`，与注销后的结果一致；`registry.test.ts` 新增单元用例，`relay/test/blackbox.test.mjs` 保持原样不加等待。验证：去掉任何同步等待的原始竞态流程在 8 路 CPU 占用下 1500/1500 为 `unknown_code`；`pnpm test:relay` 46/46，`tsc --noEmit` 通过 |

**验证（本机）**：`pnpm --filter pwa typecheck`、`lint` 无错误无警告；Node 测试 368 项、浏览器组件测试 414 项（11 项跳过）、生产 Service Worker 测试 18 项（1 项跳过）通过；`pnpm --filter pwa build` 成功；`pnpm --filter pwa test:e2e`（Playwright，桌面与移动）38 项通过；`git diff --check` 通过。未运行 Extension 与 Docker E2E，也未做 `767`／`768px`、`390`、`1440px` 明暗截图与 overlay 验证技能的实屏检查，这些并入步骤 8。

## 收口

收口前确认：前置决定已落实；步骤 1–6 的修正与验证完成，其他叠层和样式候选已有明确处置；步骤 8 的完整实屏与真机证据齐备。任一品牌刷新验收项仍未覆盖时，保留未完成范围，不据局部测试通过归档；步骤 7 的 Relay 修复已随本批实施并验证，与品牌刷新验收分别记录。

满足收口条件后，把仍有效的事实同步到 DESIGN 与相关长期文档；本方案与品牌刷新方案一起归档到 `docs/plans/completed/`，记录验证证据与遗留风险并更新受影响链接；最后更新 ROADMAP 状态。
