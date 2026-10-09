# 移动端触发式滑动手势方案

本文记录 PWA 移动布局的触发式滑动手势：产品边界、实现契约与验收。本文不独立维护项目级状态，事项状态由 [ROADMAP](../../ROADMAP.md) 维护。当前设计规则以 [DESIGN](../../DESIGN.md) 为准，实现完成后把仍有效的规则同步到 DESIGN，再归档本方案。

## 目标与非目标

目标：在移动布局（视口宽度 < 768px）为已有的点按入口补充滑动手势。手势只是一种触发方式，滑动达到阈值后调用现有的打开、关闭或返回函数，动画、焦点、history 和减少动态效果都沿用现有实现。

| 编号 | 手势 | 生效表面 | 触发后调用 |
| --- | --- | --- | --- |
| G1 | 向右滑 | 工作区主区 `<main className="pwa-main">` | 打开移动导航，与点击 `.pwa-session-trigger` 相同 |
| G2 | 向左滑 | 移动导航 Drawer 内容 | `SessionSheet` 内的 `requestClose()` |
| G3 | 向右滑 | 设置页 `.pwa-settings-view` | 设置页返回按钮的 `onBack`，即 `closeSettings` |
| G4 | 向右滑 | 工具详情阅读器（移动全屏） | `ToolReader` 的 `onClose` |
| G5 | 向右滑 | 文件阅读器（移动全屏） | `PublishedFileReader` 内的 `requestClose()` |

方向约定：叠层从哪一侧进入，就朝那一侧滑动收回。导航从左侧进入，向左滑关闭、向右滑打开；设置页和阅读器从右侧进入，向右滑返回或关闭。产品目前只有中文和英文，不考虑 RTL。

非目标：

- 不做跟手拖动、回弹、阻尼或物理动画，不接管 Mantine Drawer 和设置页转场的 transform。（该条已由 [移动端跟手拖动](20261007-follow-finger-swipe.md) 取代，识别器、捕获取消和叠层排除规则继续沿用。）
- 不引入手势库，不新增 npm 依赖。
- 不做桌面端、触控板或鼠标手势；桌面宽度下工具阅读器和文件阅读器是 720px 右侧 Drawer，同样不启用。
- 不新增下拉刷新、长按菜单、消息左滑操作或双击手势。
- 不新增手势开关设置，不改协议、Relay 或 Extension。
- 不改变现有按钮、Escape、遮罩点击和系统返回的行为。
- 不为满足测试而修改阅读器或消息内容的呈现方式。

## 现状依据

| 事实 | 依据 |
| --- | --- |
| 项目没有通用手势实现，也没有手势库依赖 | [`pwa/package.json`](../../../pwa/package.json) |
| 已有的手势先例：图片双指缩放和拖动，用 Pointer Events 加纯函数实现。它的 Browser Mode 测试把 `stage.setPointerCapture` 替换成了空函数，只验证变换逻辑，不验证浏览器的捕获和滚动行为 | [`published-image-gesture.ts`](../../../pwa/src/components/pwa/published-image-gesture.ts)、[`published-file-reader.tsx`](../../../pwa/src/components/pwa/published-file-reader.tsx)、`published-file.browser.test.tsx` |
| Browser Mode 测试已在使用 `cdp().send()` | `pwa-workspace-layout.browser.test.tsx`（`Emulation.setEmulatedMedia`） |
| 移动导航是左侧 Mantine Drawer，由 `sheetOpen` / `sheetMounted` / `sheetFocusOrigin` 控制；设备选择面板打开时，`chooserOpenRef` 会拒绝关闭 | [`pwa-workspace-layout.tsx`](../../../pwa/src/components/pwa/pwa-workspace-layout.tsx)、[`session-sheet.tsx`](../../../pwa/src/components/pwa/session-sheet.tsx) |
| 设置页通过 `pushState` / `popstate` 进出；`closeSettings` 在有设置页记录时调用 `history.back()`，来源是导航时会以展开态恢复导航 | [`settings-route.ts`](../../../pwa/src/lib/pwa/settings-route.ts) |
| 两个阅读器打开时压入不改变 URL 的历史记录，通过按钮、Escape 或遮罩关闭时会撤回这条记录；文件阅读器在有其他模态叠在上面时拒绝关闭 | [`tool-reader.tsx`](../../../pwa/src/components/pwa/tool-reader.tsx)、[`published-file-reader.tsx`](../../../pwa/src/components/pwa/published-file-reader.tsx) |
| 会话详情是 Popover，`role="dialog"` 且 `aria-modal="false"`，内部没有 menu 角色 | [`session-actions-menu.tsx`](../../../pwa/src/components/pwa/session-actions-menu.tsx)、`session-actions-menu.browser.test.tsx` |
| 消息列表本身是滚动容器，已设 `touch-action: pan-y`；body 设 `overscroll-behavior-y: none`；viewport 设 `user-scalable=no`；manifest 为 `standalone` | [`globals.css`](../../../pwa/src/app/globals.css)、[`index.html`](../../../pwa/index.html)、[`manifest.webmanifest`](../../../pwa/public/manifest.webmanifest) |
| 会话时间线中的横向滚动区包括 Markdown 表格 `.pwa-markdown-table`、代码块 `.pwa-code-block pre`、工具 diff 预览 `.pwa-tool-diff-output`（由 `tool-preview.tsx` → `tool-output.tsx` 渲染）；文件阅读器的 Markdown 表格也使用 `.pwa-markdown-table`，可独立横向滚动 | `timeline-content.css`、`tool-reader.css`、[`tool-output.tsx`](../../../pwa/src/components/pwa/tool-output.tsx)、[`file-text-content.tsx`](../../../pwa/src/components/pwa/file-text-content.tsx) |
| 工具详情阅读器用 `OutputText` 渲染，长行 `pre-wrap` 自动换行，不渲染 `.pwa-tool-diff-output`，没有横向滚动区 | [`tool-reader.tsx`](../../../pwa/src/components/pwa/tool-reader.tsx)、`tool-reader.css` 中的 `.pwa-reader-text` |
| 文件阅读器的图片舞台 `.pwa-file-image-stage` 设 `touch-action: none`，自己处理拖动；纯文本 `.pwa-file-plain` 自动换行 | [`published-files.css`](../../../pwa/src/components/pwa/published-files.css) |
| `pwa-app.tsx` 已有 930 行，超过单文件 600 行原则 | 实现时不要把手势逻辑加进这个文件 |

价值依据：Android 的系统返回手势已经能通过 `popstate` 关闭设置页和阅读器；iOS 以 standalone 方式安装后没有系统的边缘返回手势，本方案主要补这块。

## 平台约束

- Android 手势导航会占用屏幕左右边缘，iOS Safari（非 standalone）会把左边缘右滑当作浏览器后退，这两种情况网页都收不到事件。所以 **G1 不能只靠边缘触发**，起点可以在主区内任意位置，只要不落在下文的排除区域。
- 在 iOS Safari 里，左边缘右滑由浏览器执行后退：对 G3、G4、G5 来说效果一致（都会走 `popstate`）；在工作区里则保持现有行为，本方案不处理。
- 浏览器接管原生平移时会对该指针发出 `pointercancel`。要让横向位移继续以 `pointermove` 交给页面，起点所在的“最近滚动容器”必须是 `touch-action: pan-y`。浏览器判断 touch-action 时只检查到最近的滚动容器为止（Pointer Events 规范的 touch-action 判定章节），外层容器设了 `pan-y` 管不到内层滚动容器里的触摸。见下文「touch-action 配置」。
- 触摸指针默认由 `pointerdown` 的目标元素持有捕获。表面调用 `setPointerCapture` 时，捕获会从起点子元素转移到表面，子元素会收到冒泡的 `lostpointercapture`。这是正常现象，不能当作取消。

## 识别规则

识别器写成纯函数，阈值作为具名常量放在识别器模块里，真机调参时只改常量。以下为初始值：

| 常量 | 初始值 | 含义 |
| --- | --- | --- |
| `SWIPE_SLOP_PX` | 10 | 位移超过这个值才判断方向 |
| `SWIPE_DIRECTION_RATIO` | 1.5 | 方向锁定时，横向位移必须大于纵向位移的这个倍数 |
| `SWIPE_COMMIT_DISTANCE_PX` | 72 | 慢速滑动时，目标方向上需要达到的位移 |
| `SWIPE_FLICK_DISTANCE_PX` | 32 | 快速轻扫时需要达到的最小位移 |
| `SWIPE_FLICK_VELOCITY` | 0.4 | 快速轻扫的速度阈值（px/ms），以 `pointerup` 时间为终点，取最后约 100ms 内沿目标方向的有符号平均速度；向目标方向为正，反向为负 |

计算松手速度时纳入 `pointerup` 的坐标和时间，停顿时间不能省略。快速移动后停住再松手，不得沿用停顿前的速度判定为快速轻扫；距离已达到慢速滑动阈值时，仍按距离规则提交。

状态机（识别器只处理坐标和时间，不访问 DOM）：

1. `idle`：收到 `pointerdown` 且满足以下全部条件时进入 `pending`，记录 `pointerId`、起点和时间。条件：`pointerType === "touch"`、`isPrimary`、当前没有活动手势、起点不在排除区域、表面处于启用状态、此刻没有阻断叠层。
2. `pending`：位移首次超过 `SWIPE_SLOP_PX` 时判断方向。横向位移大于纵向的 `SWIPE_DIRECTION_RATIO` 倍且方向正确时进入 `tracking`；否则进入 `rejected`，直到该指针结束都不再处理。
3. `tracking`：继续记录位移和时间，用于计算松手时的速度。
4. 结束：收到该 `pointerId` 的 `pointerup` 时，目标方向位移 ≥ `SWIPE_COMMIT_DISTANCE_PX`，或位移 ≥ `SWIPE_FLICK_DISTANCE_PX` 且速度 ≥ `SWIPE_FLICK_VELOCITY`，就判定为提交；否则不做任何事。中途反向使目标方向位移小于 0，同样不提交。
5. 取消：见下文「指针捕获与取消契约」中的取消条件，取消后回到 `idle` 且不提交。

提交只发生在 `pointerup`，不在 move 过程中提前触发。提交前再检查一次表面是否仍启用、是否出现了阻断叠层，任一不满足就放弃。

## 指针捕获与取消契约

hook 必须按以下规则实现，并由下文「验收矩阵」中的 CDP 用例覆盖：

1. **只跟踪一个指针**：记录进入 `pending` 时的 `pointerId`，所有 move / up / cancel / capture 事件先按 `pointerId` 过滤，其他指针的事件一律忽略（第二触点检测除外，见第 4 条）。
2. **捕获时机**：只在进入 `tracking` 时对表面调用 `setPointerCapture(pointerId)`。`pointerdown` 时不捕获，以免普通点按的 `click` 目标变成容器。根据 hook 记录的活动 `pointerId` 和结束／取消状态决定是否请求捕获；调用时处理指针失效等异常，不能让异常中断清理。`hasPointerCapture` 只用于判断表面是否持有捕获及是否需要释放，不用于判断指针是否活跃，也不是请求捕获的前置条件。
3. **区分捕获转移和意外丢失**：在表面上监听到的 `lostpointercapture`，只有 `event.target === 表面` 且 `pointerId` 匹配时才算表面自己丢失捕获，此时取消手势。`event.target` 是表面后代的 `lostpointercapture`（起点子元素把隐式捕获交给表面）一律忽略。
4. **第二触点**：进入 `pending` 后，在 `window` 上以捕获阶段临时监听 `pointerdown`。任何其他 `pointerId` 的触摸按下（无论是否落在表面内）都取消当前手势。手势结束或取消时移除这个监听。
5. **取消条件**：该指针的 `pointercancel`；表面自身丢失捕获（第 3 条）；第二触点（第 4 条）；表面在手势过程中被禁用或卸载。
6. **清理**：手势提交、取消或 hook 卸载时，如果表面仍持有该指针的捕获，调用 `releasePointerCapture`；移除所有临时监听；状态回到 `idle`。
7. **不拦截 click**：第一版不做 click 拦截。理由是触摸位移超过点按判定范围后浏览器一般不再派发 click，而且锁定横向后捕获已经转给表面。由 CDP 用例“滑动后不误点”验证；只有该用例或真机发现误点，才增加拦截，并且拦截必须满足：只针对同一 `pointerId` 产生的 click，`detail === 0` 的键盘 click 不拦截，收到任何新的 `pointerdown`、表面关闭或卸载时立即清除，最长存活时间作为具名常量。
8. **被动监听**：`pointerdown` 和 `pointermove` 用 `passive: true`，不调用 `preventDefault`，不影响点按和纵向滚动。

## 排除区域

起点满足以下任一条件时直接忽略，不进入 `pending`：

- 位于 `input`、`textarea`、`select`、`[contenteditable]` 或输入区 `.pwa-composer` 内。
- 位于 `[data-swipe-ignore]` 内。新增这个属性作为显式退出口；文件阅读器的 `.pwa-file-image-stage` 必须加上。
- 从起点向上走到表面元素为止，路径上有任何元素能横向滚动：计算样式 `overflow-x` 为 `auto` 或 `scroll`，且 `scrollWidth > clientWidth`。用通用检测，不枚举类名，这样以后新增横向滚动区也能自动覆盖。这些元素保持默认 `touch-action`，在里面起滑时浏览器会正常横向滚动。
- 页面当前有非空的文字选区。

## 阻断叠层与启用条件

所有表面只在 `window.matchMedia("(max-width: 767.98px)")` 匹配时启用，与 `pwa-workspace-layout.tsx` 中的 `MOBILE_QUERY` 保持一致。

“阻断叠层”由一个辅助函数在 `pointerdown` 和提交前各检查一次，不在 React 渲染时缓存结果。判断范围：`.pwa-root` 内可见的 `[role="dialog"]`（**包括 `aria-modal="false"` 的非模态 dialog**，如会话详情 Popover）、`[role="menu"]`、`[role="listbox"]`，并排除当前表面自身所在的 Drawer 或页面。“可见”指元素已连接、不在 `[inert]` 或 `[aria-hidden="true"]` 内，且 `getClientRects().length > 0`；正在退出转场的 Popover 带 `inert`，不算阻断。

| 表面 | 启用条件 |
| --- | --- |
| G1 主区 | 设置页未打开且不在转场中（`settingsRoute.open === false && !transitioning`）；移动导航未打开；没有阻断叠层（覆盖输入区命令菜单、模型菜单、会话详情 Popover） |
| G2 导航 | `opened === true`；设备选择面板未打开（`chooserOpenRef.current === false`）；导航上方没有阻断叠层（如删除配对确认） |
| G3 设置页 | `settingsRoute.open && !transitioning`；没有阻断叠层（如清除数据确认） |
| G4 工具阅读器 | `opened`，移动布局（阅读器全屏）；上方没有阻断叠层 |
| G5 文件阅读器 | `opened`，移动布局；上方没有阻断叠层，并保留 `requestClose()` 里现有的模态判断 |

## touch-action 配置

每个表面按“起点所在的最近滚动容器”分别配置，只在移动断点下生效：

| 表面 | 需要设 `pan-y` 的元素 | 说明 |
| --- | --- | --- |
| G1 主区 | `.pwa-main`；消息列表 `.pwa-message-list` 已是 `pan-y` | `.pwa-main` 覆盖标题栏、提示区等非滚动子元素；输入区在排除区域内 |
| G2 导航 | 导航 Drawer 内容 `.pwa-navigation-drawer`、`.pwa-navigation-scroll` | 后者是导航列表的实际滚动容器 |
| G3 设置页 | `.pwa-settings-view` | 设置页本身就是滚动容器 |
| G4 工具阅读器 | `.pwa-tool-reader`、`.pwa-tool-reader-scroll` | 后者是正文的实际滚动容器 |
| G5 文件阅读器 | `.pwa-file-reader`、`.pwa-file-reader-scroll` | 后者是 `overflow: auto`。实现前先确认它在移动宽度下不会自身横向溢出（纯文本已自动换行）；嵌套 Markdown 表格在自己的 `.pwa-markdown-table` 内横向滚动，保持默认 `touch-action`，不因此取消外层正文区的 `pan-y`。只有 `.pwa-file-reader-scroll` 自身需要横向滚动时，才不给它设 `pan-y`，改由排除区域的通用横向检测处理，并在验收记录里写明 |

规则：

- 横向滚动区（代码块 `pre`、表格容器、diff 预览）保持默认 `touch-action`，不给它们或它们的后代设 `pan-y`，以免破坏横向滚动。
- 不改 `.pwa-file-image-stage` 的 `touch-action: none`。
- 新增滚动容器时，需要同样处理；这条规则写进 DESIGN，避免以后新增的滚动区让手势失效。

## 模块与接入

### 新增文件

| 文件 | 职责 |
| --- | --- |
| `pwa/src/components/pwa/swipe-gesture.ts` | 纯函数识别器：常量、状态类型、无副作用的状态迁移函数，不访问 DOM。命名可以调整，但要保持纯函数且能做 Node 测试 |
| `pwa/src/components/pwa/use-swipe.ts` | React hook：挂原生 Pointer 事件监听，负责排除区域、阻断叠层检查、捕获与取消契约、启用状态，提交时调用回调。阻断叠层辅助函数可以放在这里，也可以单独成文件 |
| `pwa/src/components/pwa/swipe-gesture.node.test.ts` | 识别器单测 |

hook 签名建议：

```ts
useSwipe(element: HTMLElement | null, options: {
  direction: "left" | "right";
  enabled: boolean;
  onSwipe: () => void;
});
```

传入元素而不是 ref 对象：Mantine `Drawer.Content` 可能晚于组件挂载，调用方用 `useState` 加回调 ref 拿到元素，元素变化时 hook 重新挂监听。`onSwipe` 和 `enabled` 通过 ref 保存最新值，不因变化而重挂监听；`enabled` 变为 false 时取消进行中的手势。

### 接入点

| 手势 | 文件 | 改动 |
| --- | --- | --- |
| G1 | `pwa-workspace-layout.tsx` | 给 `<main>` 拿到元素引用。提交时复用标题栏打开导航的逻辑：焦点来源取 `.pwa-session-trigger`（关闭后焦点回到这里），依次 `setSheetFocusOrigin`、`setSheetMounted(true)`、`setSheetOpen(true)`。建议把这段抽成函数，标题栏和手势共用 |
| G2 | `session-sheet.tsx` | 用回调 ref 拿到 `Drawer.Content` 元素（保留现有的 `contentRef` 用途），提交时调用 `requestClose()` |
| G3 | `pwa-workspace-layout.tsx` | 在 `.pwa-settings-view` 上启用，提交时调用新增的 `onSettingsBack` prop（由 `pwa-app.tsx` 传入 `closeSettings`，只改 JSX 传参这一处）；也可以把 `closeSettings` 往下传，以改动最小为准 |
| G4 | `tool-reader.tsx` | 在 `Drawer.Content` 上启用，提交时调用 `onClose` |
| G5 | `published-file-reader.tsx` | 在 `Drawer.Content` 上启用，提交时调用 `requestClose()`；`.pwa-file-image-stage` 加上 `data-swipe-ignore` |

G3、G4、G5 一律调用页面或叠层**现有的关闭入口**，不直接调用 `history.back()`。现有入口已经处理了 history 撤回、焦点复原和模态竞争。

### 减少动态效果与可访问性

- 手势只触发现有动作，`prefers-reduced-motion` 下的动画降级已有全局规则覆盖，不需要额外处理。
- 每个手势都有对应的可见按钮，不新增 ARIA 属性，读屏和键盘路径不变。
- 不加震动反馈，不加滑动提示动画。

## 实施顺序

1. **识别器与 hook**：完成 `swipe-gesture.ts`、`use-swipe.ts` 及 Node 单测。
2. **G1 试点**：先只接入 G1 并配置主区的 touch-action。G1 同时涉及纵向滚动容器（消息列表）、嵌套横向滚动区（代码块、表格、diff 预览）、输入区排除和非模态叠层，风险最集中。用下文的 CDP 真实触摸用例验证捕获、取消、滚动和点按机制，全部通过后再进入下一步。如果 CDP 用例暴露出契约本身的问题，先修订本方案再继续。
3. **其余手势**：接入 G2 到 G5，每个表面各补合成事件用例和至少一条 CDP“从正文子元素起滑成功”用例。
4. **自动化验收**：执行「静态检查与构建」中的全部命令。
5. **真机验收**：按「真机验收」执行。没有真机证据时，事项边界维持为“实现完成、设备验收未完成”。

## 验收矩阵

### Node 单测（`swipe-gesture.node.test.ts`）

- 低于 slop 的位移不判定方向；纵向为主的移动进入 `rejected`；斜向但低于方向比例时 `rejected`；横向但方向相反时 `rejected`。
- 目标方向慢速滑动刚好达到 / 未达到 `SWIPE_COMMIT_DISTANCE_PX`。
- 快速轻扫：位移 ≥ `SWIPE_FLICK_DISTANCE_PX` 且速度达标时提交；速度达标但位移不足时不提交。
- 快速移动后停住超过速度采样窗口再松手：位移达到快速轻扫下限但未达到慢速滑动阈值时不提交；位移已达到慢速滑动阈值时仍按距离提交。末段反向移动的速度为负，不按快速轻扫提交。
- 先往目标方向再拉回起点不提交。
- 取消后回到 `idle`，后续事件不再产生提交。

### Browser Mode 合成事件测试

用 `page.viewport()` 切换移动和桌面宽度，合成 `pointerType: "touch"` 的 PointerEvent，覆盖状态和条件分支。合成事件验证不了浏览器的原生滚动、隐式捕获和 click 派发，这些交给 CDP 用例。断言按整像素和状态判断，不依赖动画时序，计时窗口给 Linux CI 留出余量。

| 文件 | 用例 |
| --- | --- |
| `pwa-workspace-layout.browser.test.tsx` | G1 主区右滑打开导航，关闭后焦点回到 `.pwa-session-trigger`；纵向滑动、左滑、`pointerType: "mouse"`、桌面宽度均不打开；起点在输入区、有文字选区时不打开；命令菜单打开时不打开；**会话详情 Popover 打开时不打开**；`pointerdown` 时没有叠层、提交前打开了叠层时不打开；起点子元素派发冒泡的 `lostpointercapture` 不会取消手势，表面自身的 `lostpointercapture` 会取消 |
| 同上 | G3 设置页右滑返回：来源是工作区时回到工作区；来源是导航时导航以展开态恢复并恢复滚动位置；转场中、清除数据确认打开时不响应；设置页输入框里起滑不响应 |
| `session-sheet.browser.test.tsx` | G2 左滑关闭并复原焦点；右滑不关闭；设备选择面板打开或删除配对确认打开时不关闭 |
| 工具阅读器相关的 browser 测试 | G4 移动宽度下右滑关闭，压入的历史记录被撤回（`history.state` 不再含 `piReachToolReader`）；桌面宽度不响应 |
| `published-file.browser.test.tsx` | G5 移动宽度下右滑关闭，历史记录被撤回；图片舞台上单指拖动、双指缩放都不关闭；从真实文件 Markdown 组件渲染的超宽表格内起滑不关闭；上方有模态时不关闭 |
| 渲染时间线内容的现有 browser 测试，或 G1 测试中渲染真实时间线内容 | 起点在可横向滚动的代码块、Markdown 表格、工具 diff 预览内时不打开导航。用真实组件产生的 DOM，内容宽度超过容器 |

### CDP 真实触摸测试

在 Browser Mode 里通过 `cdp().send("Input.dispatchTouchEvent", …)` 派发真实触摸序列（必要时先开启触摸模拟），让 Chromium 走真实的平移、隐式捕获和 click 派发流程。用例数量保持精简，每条都留足超时；如果在 Linux CI 上不稳定，先修稳再合并，不能跳过或放宽断言。最低覆盖：

1. 从正文子元素起滑成功：G1 从消息正文的文字上起滑；G2 从导航列表行上起滑；G3 从设置页非输入控件的说明文字上起滑；G4 从工具阅读器正文行上起滑；G5 从文件阅读器非横向滚动区的正文文字上起滑。各自触发对应动作。
2. 纵向滚动正常：在消息列表、导航列表、设置页、阅读器正文中纵向拖动，滚动位置改变，且不触发手势。
3. 横向滚动区正常：在时间线的超宽代码块内横向拖动，代码块 `scrollLeft` 改变，且不打开导航；在文件阅读器的超宽 Markdown 表格内横向拖动，表格容器 `scrollLeft` 改变，且不关闭阅读器。
4. 点按与误点：在按钮上点按，按钮的 click 正常触发；从一个按钮上起滑并完成手势，该按钮不触发 click（验证第一版不拦截 click 的前提）。
5. 捕获转移与第二触点：从子元素起滑并锁定横向后不会被取消；滑动过程中第二根手指落下（包括落在表面外）时不提交。

CDP 只代表 Chromium，不能代替 iOS WebKit 和 Android 真机。

### 静态检查与构建

- `pnpm --filter pwa typecheck`、`pnpm --filter pwa lint`
- `pnpm --filter pwa test:unit`，以及受影响文件的 `pnpm --filter pwa test:component`
- `pnpm --filter pwa build`：新增 hook、组件接入和 CSS 都会进入生产 bundle，按 `pwa/AGENTS.md` 必须构建
- `git diff --check`
- 本方案不新增 Playwright E2E；Playwright 的 touchscreen 只支持点按，真实滑动由上面的 CDP 用例覆盖。

### 真机验收

按 [PWA 加固与真实设备验收](20260824-pwa-hardening.md) 的范围和记录方式执行，桌面 Chromium 的移动 viewport 不能代替真机：

| 环境 | 检查 |
| --- | --- |
| iOS Safari，添加到主屏幕后 standalone 启动 | G1 到 G5 都能触发，包括从正文中部起滑；纵向滚动消息列表、导航列表、设置页、阅读器正文不误触发；代码块、表格、diff 预览仍能横向滚动，文件阅读器内的超宽 Markdown 表格横向滚动不关闭阅读器；滑动后不误点按钮 |
| iOS Safari，浏览器内 | 左边缘右滑由浏览器执行后退，在设置页和阅读器里效果与 G3–G5 一致；在主区中部右滑能打开导航 |
| Android Chrome，手势导航 | 系统边缘返回照常工作；主区中部右滑能打开导航；G2 到 G5 正常 |
| Android Chrome，三键导航 | 同上，确认没有边缘冲突以外的差异 |

阈值在真机上手感不对时只调整识别器常量，并把最终值和调参依据记到本方案的验收记录里。

没有真机时，只声明实际拿到的自动化证据，明确写“移动真机未验证”，不能把事项标记为已完成。

## 文档同步

实现完成后：

1. 在 [DESIGN](../../DESIGN.md) 的移动导航、设置页、工具详情阅读器和文件阅读器的规则中，补上对应手势、启用条件、排除区域，以及“移动端纵向滚动容器设 `pan-y`、横向滚动区保持默认”的规则。阈值数值以代码常量为准，不在 DESIGN 里重复维护。
2. 在本方案末尾追加验收记录（日期、通过的命令、CDP 用例结果、真机环境和结论、未覆盖项、是否增加了 click 拦截及原因）。
3. 更新 [ROADMAP](../../ROADMAP.md) 中本事项的状态和边界，然后把本方案移到 `docs/plans/completed/`。

## 交付方式

- 从 `main` 新建功能分支，比如 `feature/261005-mobile-swipe-gestures`。不要在 `bugfix/261005-attachment-switch-notice` 上开发。
- 本方案文件和 ROADMAP 登记随实现一起提交。
- 提交、push、创建 Pull Request 都需要用户分别授权。PR 由 Codex 评审，评审意见逐条处理后才能合并。
- 本方案只改 PWA，不涉及协议的发布顺序。PWA 发版和部署按 [DEPLOYMENT](../../DEPLOYMENT.md) 单独授权。

## 风险

| 风险 | 应对 |
| --- | --- |
| 内层滚动容器漏设 `pan-y`，导致从正文起滑时被 `pointercancel` 取消 | 「touch-action 配置」逐表面列出滚动容器；CDP 用例 1 覆盖每类表面 |
| iOS WebKit 的 touch-action 或捕获行为与 Chromium 不同 | 真机验收专项检查；如有差异，在验收记录里写明，再决定是调整 CSS 还是在 iOS 上改用 Touch Events 监听横向位移 |
| 主区右滑和阅读时的横向操作（比如选中文字）冲突 | 已排除文字选区和横向滚动区；真机发现新冲突时加 `data-swipe-ignore`，不放宽识别规则 |
| 误触发打开导航，打断阅读 | 方向比例和距离阈值偏保守；真机调参只往更严格的方向收 |
| 手势结束后误点按钮 | 第一版依赖浏览器的点按判定和捕获转移；由 CDP 用例 4 和真机验证，发现问题再按契约第 7 条增加拦截 |
| CDP 用例在 Linux CI 上不稳定 | 用例保持精简、超时留足、断言基于状态而不是时序；不稳定时先修稳，不跳过 |

## 实施与验收记录 — 2026-10-05

G1–G5 已完成本地实现和自动化验收，当前边界为**实现完成、移动真机未验证**。分支 `feature/261005-mobile-swipe-gestures` 从 `origin/main` 的 `9e5dc06` 创建，原有方案和 ROADMAP 改动保留；未提交、push、创建 PR、发布或部署。未新增依赖，未改协议、Relay 或 Extension。

### 实现与方案差异

- 识别器与 hook 按方案实现，DOM 排除和叠层判断独立放在 `swipe-guards.ts`。`useSwipe` 增加同步 `canSwipe()` 门禁，供导航读取 `chooserOpenRef`；断点、启用条件和回调始终读取最新值。
- 接入点复用已有打开、`requestClose`、`closeSettings` 和 `onClose`，不新增 history 路径。图片舞台加 `data-swipe-ignore`，原拖动和双指缩放不变。
- 文件正文实测：纯文本及超宽 Markdown 表格的外层正文区不横向溢出，表格在自身容器横滚；原始 Markdown 的超长围栏代码会使外层正文区自身横滚。这种情况下通过尺寸观察动态保留外层 `touch-action: auto`，按方案的例外排除该正文区的滑动关闭，不修改内容换行；内容或视口变化后重新测量。
- G1 门禁发现既有工具 diff 的 Grid 子项被超长行撑宽，`pre` 自身没有横滚。经用户单独确认，在 `.pwa-tool-output-blocks` 增加 `grid-template-columns: minmax(0, 1fr)`，恢复长行自身横滚；用真实 `ToolPreview` 的 DOM 回归，不替换正文呈现。
- 浏览器用例新增在 `use-swipe.browser.test.tsx`、`mobile-swipe.browser.test.tsx`、`navigation-swipe.browser.test.tsx`、`reader-swipe.browser.test.tsx`，避免继续扩展已有长测试文件；直接 props 消费者补齐 `onSettingsBack`。CDP helper 放在 `pwa/src/test/browser/swipe.ts`，将 tester iframe 的坐标换算成 CDP 顶层视口坐标。
- 初始阈值未调整。真实触摸的按钮点按、按钮起滑和导航行起滑未出现误点，因此**没有增加 click 拦截**。

### 自动化证据

执行环境：macOS、本机 Node／pnpm、Vitest Browser Mode 的 Chromium。以下命令均从仓库根执行；本机通过既有 `.pi/tmp/bin/pnpm` 入口提供 pnpm，未修改公共运行时。

| 验证 | 结果 |
| --- | --- |
| `pnpm --filter pwa typecheck` | 通过 |
| `pnpm --filter pwa lint` | 通过；保留未改文件 `attachment-composer.node.test.ts` 的两条 unused-vars warning |
| `pnpm --filter pwa test:unit` | 通过，64 个文件、554 项测试；包含识别器全部阈值、停顿、反向和取消用例 |
| `pnpm --filter pwa test:component <下列受影响文件>` | 通过，15 个文件、303 项测试 |
| `pnpm --filter pwa build` | 通过，含共享协议前置构建与 Service Worker 产物；保留大 bundle 提示 |
| `pnpm check:docs` 及 `findBrokenLinks` 检查本轮三份文档 | 通过；后者包含尚未跟踪的本方案 |
| `git diff --check` | 通过 |

受影响 Browser Mode 文件（均在 `pwa/src/components/pwa/`）：

- 新增手势：`use-swipe.browser.test.tsx`、`mobile-swipe.browser.test.tsx`、`navigation-swipe.browser.test.tsx`、`reader-swipe.browser.test.tsx`。
- 既有回归：`pwa-workspace-layout.browser.test.tsx`、`workspace-shell.browser.test.tsx`、`session-sheet.browser.test.tsx`、`tool-preview.browser.test.tsx`、`published-file.browser.test.tsx`、`pwa-app.browser.test.tsx`、`settings-page.browser.test.tsx`、`workspace-device-control.browser.test.tsx`、`session-actions-menu.browser.test.tsx`、`confirm-action-dialog.browser.test.tsx`、`pwa-motion.browser.test.tsx`。

四个新增 Browser Mode 文件共 55 项测试，其中 18 项使用真实 CDP 触摸，不替换浏览器捕获机制。已覆盖：

- 五个表面从真实正文子元素或导航列表行起滑成功。
- 消息、导航、设置页及两个阅读器的实际纵向滚动，不误触发。
- 时间线代码块和文件 Markdown 表格的真实横滚；文件围栏代码的外层横滚例外。
- 按钮正常点按与起滑后不误点；起点子元素的隐式捕获转移；表面内外第二触点取消。
- 图片原生拖动和双指缩放不关闭文件阅读器。

独立只读审查覆盖全部冻结 PWA 变更、直接消费者、识别器、捕获与取消、叠层、history／焦点、滚动与阅读锁生命周期、CDP 真实性及 Linux 稳定性风险，**无 P0–P3 finding**。该审查不等于已经在 Linux 上执行测试。

### 未覆盖与后续

- **移动真机未验证**：尚无本方案真机矩阵中的 iOS standalone／浏览器内 Safari、Android 手势／三键导航证据；阈值手感和系统边缘竞争不能由 Chromium CDP 代替。
- 本轮未运行 Linux CI，未新增或执行本方案之外的 Playwright、Docker E2E。
- 当前实现规则已同步到 DESIGN；事项仍为“进行中”，本方案继续留在 `active/`。取得真机证据后，再记录调参依据、更新项目级状态并归档；提交和发布仍需单独授权。
