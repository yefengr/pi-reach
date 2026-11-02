# 边框、分隔与圆角参照 iOS 的调整

- 日期：2026-11-01
- 用途：在动效参照 iOS 之后，复核边框、分隔线、圆角与间距还能借鉴哪些 iOS 做法；先以对比原型确定取值，再修改规范与实现。本文不是当前实现说明。
- 项目级状态：见 [ROADMAP](../../ROADMAP.md)，本文不另设状态表。决策见 [ADR-20261101](../../adr/20261101-hairline-concentric-radii.md)。
- 基线：`main` 的 `8c94c87`。
- 当前事实来源：[DESIGN「基础层」](../../DESIGN.md#基础层)、[「嵌套、圆形与胶囊」](../../DESIGN.md#嵌套圆形与胶囊)、[「间距」](../../DESIGN.md#间距)。
- 对比原型：[`docs/prototypes/20261101-ios-borders-spacing/page.html`](../../prototypes/20261101-ios-borders-spacing/page.html)（静态评审稿，可切换浅色与深色）。

## 1. 背景

[动效分层 ADR](../../adr/20261031-motion-layers-ios-spring.md) 让内容与空间变化参照 iOS 弹簧之后，界面的「动」已接近 iOS，「静」的部分还有三处明显差异：

1. **线偏粗、偏实**。装饰分隔全部是 `1px solid var(--pwa-line)`，在 3 倍屏上是 3 个物理像素；`line` 是不透明灰（浅色 `#E0E0E0`），落在 `bg`、`panel`、`message` 上浓淡不一。iOS 分隔线为 1 个物理像素、半透明，换底色也保持同样的轻重。
2. **固定顶栏没有滚动提示**。移动会话标题区与移动设置页顶栏是实色底、无分隔，内容滚到下方时被硬切；电脑选择 Drawer 的头部又始终带分隔线。iOS 只在内容滚到栏下时才显示分隔。
3. **小内边距下的嵌套圆角不同心**。Composer 外框 16，左下附件、右下发送按钮是半径 18 的圆，距卡片边 14–16，内圆比外角还圆。浮层面板 8 内放 8 的菜单行，DESIGN 以「嵌套不递减」回避了公式算出的 2。iOS 的做法是放大外圆角，使「内圆角 + 间距 = 外圆角」。

间距已与 iOS 基本一致，不作调整：

| 项目 | Pi Reach | iOS |
| --- | --- | --- |
| 基础网格 | 4／8／12／16／24／32／48，细档 2／6／10 | 8pt 网格 |
| 页面 gutter | 移动 16、桌面 20 | compact 16、regular 20 |
| 阅读列宽 | 680 | 可读内容宽约 672 |
| 最小点击区 | 44 | 44 |
| 分区间距 | 32 | 分组列表分区约 35 |

## 2. 目标与不改动

目标：

- 装饰分隔改为设备像素发丝线与半透明分隔色，控件轮廓与状态边框不变。
- 列表内分隔线从文字起点开始，不贯穿整行。
- 固定顶栏只在内容滚到下方时显示分隔。
- 内边距较小的嵌套表面圆角同心。
- （可选，单独评审）设置页改为 iOS 式分组列表。

不改动：

- 间距档位、细档、gutter、阅读列宽与点击区。
- 颜色角色（除新增的分隔色）、阴影取值、动效。
- 输入控件轮廓 `control-line`、按钮边框、选中描边、焦点轮廓、状态色边框、左侧强调竖线。
- Modal、Toast、消息气泡、代码块与图片圆角（理由见 4.4）。
- 不引入毛玻璃材质（与 [ADR-20261001](../../adr/20261001-neutral-surfaces-mist-blue.md) 的实色中性底冲突，遮罩也刻意关闭了 `backdrop-filter`）。
- 不改侧栏导航行的 2px 间隔：圆角选中底需要分开，iPadOS 侧栏同样如此。

## 3. 现状盘点

正式 CSS 中使用 `line` 色的边框约 20 处（不含开发评审页），按用途分为：

| 类别 | 位置 | 本方案 |
| --- | --- | --- |
| 浮层外框 | `workspace-navigation.css` 电脑面板 `.pwa-device-popover`、`.pwa-peer-menu-panel`；`globals.css` 命令菜单、Toast、「最新」入口；`copy-button.css` 复制错误提示；Mantine Menu／Popover 下拉的默认边框 | 发丝线 |
| 主要输入表面 | `globals.css` `.pwa-composer-card` | 发丝线；聚焦换强调色、同宽 |
| 区块分隔 | 电脑 Drawer 头部、工具阅读器命令、Markdown `hr` 与表格、会话操作菜单分隔线 | 发丝线；Drawer 头部改为滚动边缘（4.3） |
| 列表 | 排队消息外框与行间分隔 | 发丝线；行间分隔缩进（4.2） |
| 小型装饰块 | 排队计数、排队缩略图、运行时提示 | 发丝线 |
| 只靠描边成形的块 | 在线／当前标签、电脑图标块（无底色） | **不变**：去掉底色后只剩描边，发丝线会让形状发虚（实施时补充） |
| 控件 | 次级按钮、电脑触发按钮 `border-color: line` | **不变**：浅色下 `surface` 与 `bg` 同为白色，次级按钮只靠这条边界识别 |
| 状态与选中 | `running-line`／`error-line` 提示条、设置单选卡片选中的 `ink` 描边、`control-line` 输入与开关 | **不变** |

守卫现状：[`pwa-style-guard`](../../../pwa/src/app/pwa-style-guard.node.test.ts) 只允许边框宽度 0／1／2／3px，圆角 token 固定为 4／8／12 与 Composer 16，Composer token 只允许用于输入卡片。

## 4. 调整项

### 4.1 发丝线与分隔色

> 实施时修正：Chromium 画不出 0.5px，线宽与分隔色改为按实测结果分两档，见 [8.4](#84-chromium-发丝线修正)。下表为评审时的原始取值。

新增两个 token：

| token | 浅色 | 深色 | 说明 |
| --- | --- | --- | --- |
| `--pwa-hairline` | `1px`；`@media (min-resolution: 2dppx)` 下 `0.5px` | 同左 | 1 倍屏保持 1px，2 倍及以上为 1 个物理像素左右 |
| `--pwa-separator` | `#00000033` | `#FFFFFF2E` | 半透明中性色（R=G=B）。叠在 `bg` 上分别约为 `#CCCCCC`、`#464646` |

取值理由：线宽减半后需略加深颜色以保持可见。深色叠在 `bg` 上恰好等于现在的 `line`；浅色比 `line` 深一档，接近 iOS `separator` 叠白底后的明度。最终取值以原型与真机目测为准。

规则：

- 第 3 节标为「发丝线」的位置统一写作 `border: var(--pwa-hairline) solid var(--pwa-separator)`。
- `line` 保留给按钮边框等仍需 1px 的中性边界；不再用于新的装饰分隔。
- 分隔色只辅助分区，不承担识别职责，不设对比度下限；需要靠轮廓识别的控件仍用 `control-line`（≥ 3:1）且保持 1px。
- Composer 聚焦只把边框换为 `accent`，宽度不变，避免 0.5px 的布局抖动；真机上若聚焦过弱，再改为外加 `outline`，不加粗边框。
- Mantine 下拉的默认边框经 `--mantine-color-default-border` 读取 `line`，宽度为 1px；实施时为 Menu、Popover 下拉统一加一条覆盖规则，不逐个组件处理。

### 4.2 列表分隔线缩进

iOS 列表的行间分隔从首个文字（或图标后的文字）起，到行尾止；分区外框和顶栏分隔仍贯穿全宽。iOS 分组没有外框，右端伸到边缘不会与其他线相接；Pi Reach 的列表容器可能带外框，因此按容器区分：

- **有外框的容器**：左右对称缩进，分隔线不碰外框，避免右侧与外框形成 T 形接口而左侧留空。
- **无外框的分组**：按 iOS 只缩进左侧，右端伸到分组边缘。

适用位置：

- 排队消息（有外框）：行间分隔左右各缩进 12（与行左内边距一致）。改用 `::before` 定位绘制，不再用 `border-top`，行高不变。
- 设置页分组列表（4.5，如采纳）：分隔从图标后的文字起（左 46 = 内边距 16 + 图标 20 + 间隔 10）。
- 其他全宽分隔（Drawer 头部、阅读器命令、Markdown）不缩进。

### 4.3 滚动边缘分隔

| 位置 | 现状 | 调整后 |
| --- | --- | --- |
| 移动会话标题区（消息列表上方） | 无分隔 | 消息列表离开顶部时显示 |
| 侧栏展开时桌面主区卡片的标题区 | 无分隔 | 同上 |
| 移动设置页固定顶栏 | 无分隔，内容被硬切 | 设置页滚动后显示 |
| 电脑选择 Drawer 头部 | 始终显示 | 列表滚动后显示 |
| 工具与文件阅读器 Drawer 头部 | 实施时核对 | 同一规则 |

- 分隔用 `::after` 绘制发丝线，按 `--pwa-duration-fade` 淡入淡出，不改变布局。
- 由滚动容器写入 `data-scroll-edge`（滚动距离大于 0 时存在），顶栏用属性选择器显示分隔；先核对能否并入 [`useScrollIndicator`](../../../pwa/src/lib/ui/scroll-indicator.ts) 已有的滚动监听，不另起一套。
- 底部（Composer 上方）不加：最新内容通常贴底，分隔会常驻，与 iOS 信息 App 一致。
- iOS 26 改用渐隐边缘（scroll edge effect）替代发丝线；渐隐需要遮罩与额外合成层，与实色顶栏也不协调，本轮只做发丝线。

### 4.4 同心圆角

DESIGN「嵌套不递减」改为：

- 内边距（内表面到外缘的距离）不大于 16 时，外圆角 = 内圆角 + 内边距。只放大外圆角，不缩小内圆角，结果需落在圆角 token 内。
- 内边距更大时，内外圆角各按自身角色取值，不要求同心（视觉上已不相关）。

| 表面 | 现状 | 调整后 | 同心核算 |
| --- | --- | --- | --- |
| Composer 输入卡片 | 圆角 16，内边距上下 10、左右 12 | `--pwa-radius-composer` 改为 **32**，内边距不变 | 左下附件与右下发送为半径 18 的圆，距底边 10 + 4 = 14、距侧边 12 + 4 = 16：18 + 14 = 32，水平方向差 2，可接受 |
| 浮层面板（Menu、Popover、命令菜单、电脑面板） | 圆角 8，内边距 6，菜单行 8 | 圆角 **12**、内边距 **4**，菜单行 8 不变 | 触控：8 + 4 = 12。细指针菜单行上下另有 2 的视觉内缩，纵向 8 + 6 = 14，差 2，可接受 |

不处理：

- Modal（12，内边距 24／16）：内边距大，不要求同心。
- Toast（8，左 12、右 4）：右侧关闭按钮的圆形底只在悬停或按下时出现，同心需要胶囊外形，改变过大。
- 消息气泡、代码块、图片：内部没有贴边的子表面。

影响：

- 浮层内边距 6 → 4：DESIGN「间距」细档表中「浮层面板内边距 6」删除，改用通用档位 4；菜单行左右 10 不变，文字到面板边缘由 16 变为 14。
- Composer 圆角加大后，附件卡片（8）位于输入卡片顶部，距边 10–12，与 32 的外角不同心。附件只在添加后出现，且与外框之间隔着整行留白；原型中目测，若不协调，附件卡片单独取 12。

### 4.5 设置页分组列表（可选）

当前设置页是表单式分区：标题、说明、三张独立单选卡片（选中项 `ink` 描边）。iOS 设置使用分组列表。原型给出对照，是否采纳单独决定，不随 4.1–4.4 一并实施。

| 项目 | 调整后 |
| --- | --- |
| 页面底 | 新增别名 `--pwa-grouped-bg`：浅色 `panel`、深色 `bg`。深色下 `panel` 与 `surface` 过近，不能直接用 `panel` |
| 分组 | `surface` 底、圆角 12、无边框、无阴影；与页面 gutter 16 对齐 |
| 行 | 最小高 44，左右 16；图标 20、图标与文字 10、主副文字 2；行间发丝线从文字起（4.2） |
| 单选 | 改为行尾 20 的强调色对勾（与单选圆点一样用 `accent`），取消选中描边；整行仍是 radio，保留键盘方向键与读屏语义 |
| 开关、跳转 | 开关放行尾；「键盘快捷键」改为带右箭头的行 |
| 分区标题与说明 | 标题在分组上方，间距 8；说明移到分组下方，间距 6（沿用「附属说明」细档） |
| 分区间距 | 32 不变 |

风险：选中态从「整卡描边」变为「对勾」，选中信号变弱；Relay 地址输入框放进分组行会改变表单布局，原型只演示外观、字体大小、键盘与关于四个分区。

## 5. 规范与守卫变更

| 文件 | 变更 |
| --- | --- |
| `pwa/src/app/pwa-theme.css` | 新增 `--pwa-hairline`、`--pwa-separator`（浅色、深色与系统深色回退三处）；`--pwa-radius-composer` 改为 32；采纳 4.5 时新增 `--pwa-grouped-bg` |
| `pwa-style-guard.node.test.ts` | 边框宽度允许 `var(--pwa-hairline)`；`0.5px` 字面量只允许出现在 `--pwa-hairline` 的高分屏定义中；Composer 圆角期望值改为 32 |
| `pwa-theme-contrast.node.test.ts` | 校验 `--pwa-separator` 为 R=G=B 的半透明色，且深色回退与深色主题同值 |
| `docs/DESIGN.md` | 视觉 token 表新增分隔色；「基础层」圆角与边框规则；「嵌套、圆形与胶囊」改为同心规则；「间距」细档表删除浮层内边距 6；新增滚动边缘分隔规则 |
| `docs/adr/` | 新增 ADR：发丝线与同心圆角取代「嵌套不递减」；4.5 如采纳另记 |

## 6. 实施批次与验证

| 批次 | 内容 | 自动化验证 | 人工验收 |
| --- | --- | --- | --- |
| 1 | 4.1 发丝线、4.2 排队消息分隔缩进 | 样式守卫、对比度测试；`pnpm --filter pwa lint`、`typecheck` | 2 倍、3 倍屏与 1 倍桌面屏目测分隔是否可见 |
| 2 | 4.3 滚动边缘 | 浏览器组件测试：滚动前无 `data-scroll-edge`、滚动后存在、回顶后移除（设置页、电脑 Drawer、消息列表） | iOS 真机滚动设置页与会话 |
| 3 | 4.4 同心圆角 + DESIGN + ADR | 守卫；覆盖 Composer 与菜单的现有浏览器测试 | 对照原型目测 Composer 四角与菜单 |
| 4（可选） | 4.5 设置页分组列表 | `settings-page.browser.test.tsx` 的选择、键盘与读屏语义 | 单独原型评审通过后再排期 |

每批收尾执行受影响验证与 `git diff --check`；涉及 Menu、Popover 叠层时按 [overlay 验证技能](../../../.agents/skills/validate-mantine-stacked-overlays/SKILL.md) 复核。PWA 改动推到 `feature/*` 会部署 staging，推送前确认。

## 7. 原型评审

2026-11-01 用户在浏览器中评审对比原型：

- 排队消息的行间分隔原为只缩进左侧，右端与外框相接、两侧不对称；已改为左右各缩进 12，并补充 4.2 的「按有无外框区分」规则。
- 其余各组（分隔色与发丝线、滚动边缘、Composer 32、浮层 12／4、设置页分组列表外观）未提出异议。

仍需确认：

1. 真机（iOS Safari，2 倍与 3 倍屏）上发丝线与分隔色的可见度，在批次 1 的人工验收中完成。
2. 设置页分组列表是否排期；原型外观无异议，但改动较大，按批次 4 单独决定，不随批次 1–3 实施。
3. `corner-shape: squircle`（iOS 式连续曲率圆角）暂不纳入：主要用户在 iOS Safari，支持情况未核实，待支持后再评估渐进增强。

## 8. 实施记录

2026-11-01 在分支 `feature/261101-ios-borders-spacing`（基于 `main` 的 `8c94c87`）实施批次 1–3，随后经用户确认实施批次 4（见 8.5）。

### 8.1 改动

| 批次 | 文件 | 内容 |
| --- | --- | --- |
| 1 | `pwa-theme.css`、`lib/ui/hairline.ts`、`main.tsx` | 新增 `--pwa-hairline` 与 `--pwa-separator` 两档（见 8.4）：默认 1px 配常规分隔色，首屏前实测画得出 0.5px 时根元素加 `data-pwa-hairline`，改为 0.5px 配较深分隔色 |
| 1 | `globals.css`、`workspace-navigation.css`、`queued-messages.css`、`copy-button.css`、`timeline-content.css`、`tool-reader.css` | 浮层与 Toast、「最新」入口、Composer、命令菜单、电脑面板与菜单、复制错误提示、运行时提示、会话操作分隔线、Markdown `hr` 与表格、阅读器命令分隔、排队消息外框、计数与缩略图改为发丝线 |
| 1 | `queued-messages.css` | 行间分隔改为 `::before`，左右各缩进 12 |
| 2 | `scroll-indicator.ts` | 在已有的捕获阶段滚动监听中按 `scrollTop > 0` 写入 `data-scroll-edge`，只在状态变化时写入 |
| 2 | `workspace-shell.css`、`workspace-navigation.css` | 会话标题区、阅读器头部、电脑 Drawer 头部用 `:has()` 读取下方滚动容器状态，淡入发丝线；移动设置页固定顶栏读取设置页滚动状态；电脑 Drawer 头部的常驻分隔移除 |
| 3 | `pwa-theme.css`、`globals.css`、`workspace-navigation.css` | `--pwa-radius-composer` 改为 32；电脑面板、电脑菜单、Composer 菜单、命令菜单改为圆角 12、内边距 4 |
| 文档 | `DESIGN.md`、ADR、ROADMAP | 同步 token、边框与分隔、同心、间距细档、滚动边缘分隔、Composer 与排队消息描述 |

### 8.2 与方案的差异

- 在线／当前标签与电脑图标块没有底色，只靠描边成形，保持 1px `line`（第 3 节已补充）。
- 移动导航 Drawer 的头部与桌面侧栏品牌行不在 4.3 列出的位置中，本次未加滚动边缘分隔；如需统一，另行处理。
- 桌面设置页标题不固定，滚动边缘伪元素只在移动端设置页生成。
- 4.1 预计的 Mantine 下拉统一覆盖规则不需要：现有 Menu、Popover 下拉都带项目类名并自行声明边框，逐个改为发丝线即可。

### 8.3 验证

- Node 静态守卫（`pwa-style-guard`、`pwa-theme-contrast`、`pwa-script-token-guard`、`pwa-button-guard`、`pwa-layer-guard`）：50 项通过。新增「发丝线 token 只在主题定义且高分屏为 0.5px」「发丝线边框只配分隔色」「分隔色为半透明中性色」三项检查。
- 浏览器组件测试（定向）：`queued-messages` 全文件 14 项、`scroll-indicator` 全文件 16 项（新增顶栏滚动边缘、桌面设置页不生成、横向滚动不触发三项）、`pwa-controls` 与 `workspace-device-control` 全文件 18 项、`message-composer` 与 `tool-preview` 定向用例通过。
- 未覆盖：全量 Browser Mode 与 E2E 以 Pull Request CI 为准；Vitest 浏览器为 1 倍屏，0.5px 渲染只在原型截图（2 倍）中目测，iOS 2 倍／3 倍真机可见度待 staging。叠层的 Portal、焦点与 Escape 行为未改动，未执行 overlay 验证技能。

### 8.4 Chromium 发丝线修正

实施后在 Chromium 151 中逐像素核对：2 倍、3 倍屏下 `0.5px` 边框仍占 2、3 行物理像素，即 1 个 CSS 像素，`getComputedStyle` 也报告 1px；只有 WebKit 会画成 1 个物理像素。原方案按 `min-resolution: 2dppx` 启用 0.5px 并统一加深颜色，会让桌面 Chrome、Edge 与 Android 的分隔线比原来更重。原型评审时使用的是 Chrome，看到的是加深后的 1px 线。

经用户确认改为两档：

| 档位 | 条件 | 线宽 | 浅色 | 深色 |
| --- | --- | --- | --- | --- |
| 常规 | 默认 | 1px | `#0000001F`（叠在白底上为 `#E0E0E0`，与原 `line` 同深） | `#FFFFFF2E`（叠在 `bg` 上为 `#464646`） |
| 发丝线 | 根元素 `data-pwa-hairline` | 0.5px | `#00000033` | `#FFFFFF3D` |

`lib/ui/hairline.ts` 在首屏渲染前插入只有上边框的探针，按排版高度是否小于 1 判断，并在窗口跨过 2 倍密度时重新检测。原型同步改为同一检测。深色发丝线档 `#FFFFFF3D` 未经目测，在 Safari 与 iOS 真机验收时确认。

验证：Node 守卫 51 项通过（守卫改为检查 0.5px 与较深分隔色只在 `data-pwa-hairline` 下定义；对比度测试校验常规档与 `line` 同深、发丝线档更深）；新增 `hairline.browser.test.tsx` 3 项（Chromium 下检测结果为否并清理探针、浅色与深色下标记同时切换线宽与颜色）；受影响组件测试重跑通过。WebKit 分支无本地浏览器可测，依赖 Safari／iOS 验收。

### 8.5 批次 4：设置页分组列表

用户确认后实施，取代 4.5 中「原型只演示四个分区」的范围，覆盖全部分区：

| 分区 | 实现 |
| --- | --- |
| 外观、字体大小、语言 | `SettingsChoice` 单选行：图标、主副文字、行尾 `accent` 对勾；Mantine `Radio` 的原生 radio 视觉隐藏并铺满整行，语义、方向键与读屏名称不变，焦点在整行绘制内缩轮廓 |
| 键盘 | 开关行（`labelPosition="left"`，开关在行尾）与「键盘快捷键」跳转行（右箭头） |
| 连接 | 内边距 16 的分组内放 Relay 地址与「保存设置」，标签到输入框 8、输入项到主操作 16 不变 |
| 浏览器数据 | 「重置布局」`accent` 操作行、「清除本地数据」错误色操作行（仍先确认），两条说明在分组下方 |
| 关于 | 版本为键值行，复制按钮仍在标题右侧，当前 Pi 在分组下方 |
| 滚动诊断 | 只在诊断开关开启时出现，沿用原表单样式，未改为分组 |

另外的改动：

- 新增 `--pwa-grouped-bg`（浅色 `panel`、深色 `bg`），设置页、移动顶栏、桌面状态栏遮挡条与 iOS 状态栏背景条在设置页时取该色。浏览器 `theme-color` 仍为 `bg`，浅色下浏览器工具栏与设置页底色略有差异。
- 手势起点排除从所有 `input` 收窄为不含 radio 与 checkbox：铺满整行的 radio 原会让设置页无法从单选行拖动返回（`settings-drag` 7 项因此失败后修正）。

验证：`settings-page` 21 项（新增单选行整行点击、对勾、方向键与焦点轮廓，以及分隔缩进 46／16 两项）；`settings-drag`、`mobile-swipe`（新增 radio、checkbox 起点可拖动两项）、`confirm-action-dialog`、`viewport-diagnostics-settings`、`settings-page-isolation`、`ui-state-surfaces`、`ui-state-navigation`、`navigation-swipe`、`ui-controls` 全文件通过；`pwa-workspace-layout` 与 `pwa-app` 中涉及设置页的定向用例通过；Node 守卫通过。未覆盖：读屏实机朗读、iOS 真机手势与 Safari 下的对勾与分隔观感。

### 8.6 最终对照与调整

评审确认 Pi Reach 是网页应用，借鉴平台规则而不照搬外观，并允许推翻不合理的现有规则。最终对照原型见 [`final.html`](../../prototypes/20261101-ios-borders-spacing/final.html)（PR 之前的 main 与最新建议并排）。在 8.1–8.5 的基础上：

| 类别 | 调整 |
| --- | --- |
| 撤回 | 设置页单选恢复行首可见圆点，取消行尾对勾与隐藏铺满整行的 radio；浏览器数据恢复为按钮（放在内边距 16 的分组中）；手势起点排除规则恢复 `main` 原样 |
| 新增 | 次级按钮（`default`）为无边框 `tonal` 底；危险入口（`outline`）为无边框 `error-wash` 底与错误色文字；状态标签为 `tonal` 胶囊；「最新」入口为胶囊；Toast 圆角 22；用户消息气泡与骨架 16；底部电脑选择面板上沿 16 |
| token | `--pwa-tonal`／`-hover`／`-active`、`--pwa-error-wash-hover`、`--pwa-radius-xl`（16）、`--pwa-radius-toast`（22）、`--pwa-radius-pill` |
| 不采纳 | 毛玻璃、连续曲率圆角、顶栏渐隐、所有按钮胶囊、设置分组加大到 20 以上（理由见 ADR-20261101 补充决策） |

验证：Node 守卫与对比度 53 项通过（专用圆角按选择器登记并检查登记失效；`tonal` 上的 `ink`、`secondary` 与悬停、按下档上的 `ink` ≥ 4.5:1；危险悬停混色比例固定）；Browser Mode `settings-page`、`pwa-controls`、`ui-controls`、`pwa-operation-notifications`、`copy-button`、`pwa-notice-layout`、`settings-drag`、`mobile-swipe`、`workspace-device-control`、`confirm-action-dialog`、`ui-state-surfaces`、`ui-state-navigation`、`navigation-swipe`、`queue-turn-handoff` 共 168 项，`pwa-workspace-layout` 全文件 78 项，`message-send`、`queued-messages`、`hairline`、`scroll-indicator` 共 120 项通过。未覆盖：深色 `tonal` 与危险悬停底的目测、iOS 真机与 Safari 观感。

### 8.7 滚动边缘改为内容渐隐

桌面评审认为会话标题区下的发丝线横穿主区卡片、长会话中几乎常亮，用户确认两端统一改为内容渐隐，并覆盖输入区上沿与 4.3 的全部顶栏位置。取代 4.3 的发丝线分隔，以及 4.3 中「iOS 26 渐隐边缘……本轮只做发丝线」的取舍，决策见 [ADR-20261101 补充决策](../../adr/20261101-hairline-concentric-radii.md#补充决策滚动边缘改为内容渐隐2026-11-01)。

| 位置 | 实现 |
| --- | --- |
| 会话主区顶部 | 消息列表 `::before` sticky 钉在列表顶端，上外边距抵消自身高度；不挂在标题区下，避免盖住提示区 |
| 会话主区底部 | `.pwa-chat-footer::before` 向上挂出常驻渐变；「最新」入口按文档顺序画在其上；紧凑高度下不加 |
| 阅读器、电脑 Drawer、移动设置页 | 原发丝线伪元素改为 `top: 100%` 向下挂出渐变，仍读 `data-scroll-edge`；阅读器头部取局部层级 1 |
| token | 新增 `--pwa-scroll-fade`（24px） |
| 顺带修正 | 电脑选择 Drawer 头部底色改为 `surface`：原取 Mantine `body`（`bg`），深色下与面板不同色，渐变无法无缝接出 |

验证：Node 样式、层级与对比度守卫 45 项通过；`scroll-indicator` 21 项（重写顶栏用例：四处离开顶部淡入、回到顶部淡出、不画线；首条消息不被推开；浅色与深色下渐变起点色等于顶栏底色；紧凑高度不加底部渐隐；桌面设置页不生成）；`use-timeline-viewport`、`message-send`、`pwa-notice-layout` 126 项通过。Playwright 截取 ui-states「长文字」桌面 1280 与移动 390、浅色与深色，渐隐无灰带、不横穿留白。未覆盖：iOS Safari 真机长会话滚动流畅度与观感，全量浏览器回归以 Pull Request CI 为准。
