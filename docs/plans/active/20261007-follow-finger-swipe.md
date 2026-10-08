# 移动端跟手拖动方案

本文记录 PWA 移动布局把触发式滑动手势升级为跟手拖动的方案：目标、设计、分阶段实施与验收。本文不独立维护项目级状态；该事项已登记到 [ROADMAP](../../ROADMAP.md)。当前设计规则以 [DESIGN](../../DESIGN.md) 为准，实现完成后把仍有效的规则同步到 DESIGN，再归档本方案。

接续 [移动端触发式滑动手势](20261005-mobile-swipe-gestures.md)：该方案的非目标"不做跟手拖动"由本方案取代，识别器、捕获取消和叠层排除规则继续沿用。该方案的真机验收尚未完成，本方案的真机验收与其合并进行。

## 背景与问题

用户在真机上观察到两个现象：

1. 设置页返回能跟手，侧边导航展开和阅读器返回不能。
2. 进入过一次设置页并返回后，向左滑动又进入了设置页。

观测环境（iOS Safari 标签页还是添加到主屏幕的 standalone）未记录，见「待确认」。下表按"Safari 标签页"推断；若现象 1 出现在 standalone 下，说明 standalone 也有系统边缘返回，触发式方案的价值依据和本方案防护第 4 条都要重估。

原因（代码推断，未经真机验证）：

| 现象 | 原因 |
| --- | --- |
| 设置页返回跟手 | 来自浏览器的边缘后退手势：进入设置页时 `pushState` 了一条记录，系统后退触发 `popstate`，带 `hasUAVisualTransition`，由浏览器绘制转场，应用不再叠加（[`settings-route.ts`](../../../pwa/src/lib/pwa/settings-route.ts)） |
| 导航展开不跟手 | 导航不是 history 记录，系统没有对应手势；应用内右滑是触发式，`useSwipe` 只在 `pointerup` 时判断一次，拖动期间没有位移（[`use-swipe.ts`](../../../pwa/src/components/pwa/use-swipe.ts)） |
| 阅读器返回不跟手 | 从屏幕左缘起手时走系统边缘后退，与设置页一致；从中部起手走应用内触发式，不跟手 |
| 返回后向左滑又进入设置页 | 页内返回调用 `history.back()`，设置页记录仍留在前进栈；Safari 标签页内从右缘向左滑是浏览器前进，触发 `popstate` 重新打开设置页。[DESIGN](../../DESIGN.md) 已记录"浏览器前进重新进入时照常播放进入转场"；应用自身的 `useSwipe` 没有向左进入设置页的手势 |

## 目标与非目标

目标：移动布局（视口宽度 < 768px）下，应用内手势拖动过程中让面板实时跟随手指，松手后再决定提交或回弹。

| 编号 | 表面 | 方向 | 跟随的元素 |
| --- | --- | --- | --- |
| D1 | 工具详情阅读器关闭 | 右 | Drawer 内容 + 遮罩 |
| D2 | 文件阅读器关闭 | 右 | Drawer 内容 + 遮罩 |
| D3 | 移动导航关闭 | 左 | Drawer 内容 + 遮罩 |
| D4 | 设置页返回 | 右 | 设置层 + 工作区层 |
| D5 | 移动导航打开 | 右 | Drawer 内容 + 遮罩 |

非目标：

- 不处理"返回后前进栈里仍有设置页"：见下文「已否决的方向」。
- 不改桌面、鼠标和触控板行为，不引入手势库，不改协议、Relay 或 Extension。
- 不改 history 的写入规则，不改系统边缘手势路径（`hasUAVisualTransition` 分支）。
- 不追求与系统转场逐像素一致；视差和阴影只作为可选项，见「可选项」（2026-10-08 已由设置页覆盖模型取代）。

## 已否决的方向：清除前进栈里的设置页

浏览器只有 `pushState` 能截断前进栈，所有变通办法都有副作用，因此不做：

| 做法 | 问题 |
| --- | --- |
| 返回后再 `pushState` 一条同址记录 | 多出一条重复记录，安卓要多按一次返回才能退出应用 |
| 返回后自动再 `history.back()` 跳过重复记录 | Safari 里 `popstate` 内无用户激活的 `back()` 可能被忽略，原生转场还会连播两次 |
| 前进进入设置页时立刻弹回 | 先闪一下设置页，再闪回来 |
| 用 `replaceState` 把设置页改成工作区副本 | 同样多出一条重复记录 |

浏览器前进重新进入设置页属于标准行为，保持现状。若之后仍要治理，可评估"在 history state 记录 seq 序号，识别前进并弹回"，须真机验证后另立事项。

## 与系统手势的关系

应用内跟手与系统手势并存，互不替代：

| 场景 | 处理方 |
| --- | --- |
| 屏幕边缘起手（iOS Safari 左右缘、Android 两侧） | 系统或浏览器。页面是否先收到 `pointerdown`／`pointermove` 再收到 `pointercancel` 未经验证，按"可能收到"设计防护 |
| 主区或面板中部起手 | 应用内手势 |
| 系统手势触发的后退或前进 | 既有 `popstate` 流程 |

须补四条冲突防护：

1. 手势被打断（`pointercancel`、第二触点、媒体查询变为桌面）：面板从当前位置回弹到起点，不能留在半路，也不能瞬间跳回。
2. 拖动或收尾期间表面被外部关闭（Android 返回键、`popstate`、按钮）：不回弹，从当前位置继续走到关闭终点，或交给现有转场从当前位置续播，见「外部关闭」。
3. 边缘起点：Safari 标签页内（`(display-mode: standalone)` 不匹配）向右拖动的起点落在左缘 `SWIPE_EDGE_EXCLUSION_PX` 以内时，`drag.start` 返回 `false`，退回触发式，避免应用面板与系统后退快照同时移动。宽度先取 24px，以真机结果为准；standalone 不排除，因为下一条判断它没有系统边缘返回。
4. iOS 以 standalone 方式安装时，[触发式方案](20261005-mobile-swipe-gestures.md)记录为没有系统边缘返回手势，应用内手势是该场景下唯一的跟手来源。该判断未经真机验证，须在 iOS 真机核对；结论不同时同步调整第 3 条。

应用内部的一致性：同一面板用按钮、触发式滑动或跟手拖动关闭，时长、曲线与终态相同。Drawer 由 Mantine 用 CSS transition 驱动，拖动用 WAAPI，两者无法共用 keyframes，一致性靠同一组 token 保证：时长取 `--pwa-duration-drawer`／`--pwa-duration-page`，曲线取 `--pwa-ease-standard` 的计算值，终点位移与 `pwaDrawerTransitions`、设置页转场一致。与系统转场只能接近：系统由浏览器用快照绘制，iOS 下层页面带视差和阴影，曲线是弹簧式，阈值自定，应用无法逐项复刻。

## 核心设计

拖动期间不改 React 状态，不写内联 style：对目标元素创建暂停的 WAAPI 动画（`easing: linear`、`fill: both`、`duration: 1000`），用 `currentTime = progress × 1000` 驱动。选择 WAAPI 的原因：

- 动画层级高于内联样式，不会与 Mantine `Transition` 写入的 transform 冲突。
- [`use-page-transition.ts`](../../../pwa/src/components/pwa/use-page-transition.ts) 已有"中途切换时从当前位置继续"的逻辑，可直接复用。
- 静止态提交后取消动画即可，不留残留；取消时机见下文 `swipe-drag.ts`「提交后的顺序」。

WAAPI 约束：

- `easing` 不接受 `var()`。`PWA_DRAWER_EASE`（`"var(--pwa-ease-standard)"`）只能给 Mantine 用；WAAPI 读取 `--pwa-ease-standard` 的计算值。把 `use-page-transition.ts` 里现有的读取与回退抽成共用函数，两处复用。
- keyframes 只用 px、百分比和数值，不含 `var()`。减少动态效果时不走跟手（见下文），不需要 `--pwa-motion-shift`。

### 识别器（`swipe-gesture.ts`，保持纯函数）

- `ActiveSwipe` 新增 `lockOffset`：在 `pending → tracking` 那一帧记录当时的有符号位移，使面板从 0 开始，避免约 10px 的跳变。
- 新增 `trackedDistance(state, point) = max(0, signedDistance − lockOffset)`，只用于面板显示。
- 提交判定仍按原始有符号位移和现有阈值（72px、32px、0.4px/ms、10px、1.5），与触发式一致；面板显示比判定位移少 `lockOffset`，属预期。
- `finishSwipe` 增加返回 `reversed`：松手末速度 ≤ −`SWIPE_FLICK_VELOCITY`。跟手模式下 `committed && !reversed` 才提交，拖过阈值后反向甩回会回弹；触发式不使用该字段，行为不变。

### `useSwipe` 新增可选参数

```ts
drag?: {
  start(): boolean | void;       // 指针捕获成功后调用；返回 false 拒绝，本次退回触发式
  move(distance: number): void;  // trackedDistance，已 ≥ 0
  end(r: { committed: boolean; velocity: number; distance: number }): void;
  cancel(reason: "interrupted" | "blocked" | "disabled"): void;
}
```

- `interrupted`：`pointercancel`、第二触点、媒体查询变化、`lostpointercapture`。
- `blocked`：`canSwipe()` 变为 `false` 或 `swipeBlocked()` 变为 `true`，例如拖动中出现确认框或设备选择器。门禁受阻不代表底层表面已关闭。
- `disabled`：`enabled` 变为 `false`，只通知手势不可继续，不据此推断表面已关闭。
- 控制器处理取消时先核对实际表面状态：仍打开时回弹，不调用关闭入口、不改 history；已关闭时按「外部关闭」交接，不再回弹。表面已卸载时只 `dispose`。因此，即使取消事件与外部关闭同时发生，也以实际表面状态为准。
- 只有本次 `drag.start` 已接受拖动时，hook 才在 `pointerup` 调用 `drag.end`，由控制器在收尾后调用原关闭或返回函数。`start` 返回 `false` 时，本次仍走原 `onSwipe`；没有 `drag` 时行为与现在完全一致。
- 减少动态效果（`--pwa-motion-shift` 为 `0`）、命中边缘排除或控制器正在收尾时，`start` 返回 `false`。
- "拖动中"豁免只放宽本次拖动自己引起的预挂载或转场条件，不放宽实际打开状态、移动断点和阻断叠层门禁；否则外部关闭或新叠层会被误当成拖动仍可继续。

### 新模块 `swipe-drag.ts`（约 100 行，纯 DOM 工具）

```ts
createSwipeDrag({ targets: [{ element, keyframes }], extent: () => number, duration: () => number })
  → { setDistance(px), settle(toEnd, velocity): Promise<boolean>, settling(): boolean, progress(): number, dispose() }
settleDuration(remaining: number, velocity: number, full: number): number
```

- `setDistance`：`progress = clamp(px / extent, 0, 1)`。`extent` 取目标元素实际宽度，不按 CSS 公式推算。
- `settle`：取消暂停的动画，按计算出的标准曲线从当前位置新建动画，走到终点或起点；必须 `fill: "forwards"`，保证 `finished` 之后到 React 提交之前末帧不变。完成时 resolve `true`；被 `dispose` 或新的 `settle` 中止时 resolve `false`，不抛出。
- `settleDuration`：`clamp(remaining / max(velocity, 0.3), 80ms, full)`，`full` 为全程时长 token；P3 交接时复用。
- 提交后的顺序：先保持末帧，再提交 React 状态，等到静止态已提交（Drawer 已卸载、打开态已生效）或 `onExitTransitionEnd` 之后才 `dispose`。不依赖 `flushSync` 是否同步刷新 Mantine 的 passive effect，避免闪一帧。

### 收尾期间与外部关闭

`settle(toEnd)` 的布尔值只表示 keyframes 的终点或起点，不表示业务上的打开或关闭：

| 表面 | 起点（progress = 0） | 终点（progress = 1） | 外部关闭时的目标 |
| --- | --- | --- | --- |
| D1、D2 阅读器关闭 | 打开 | 关闭 | `settle(true)` |
| D3 导航关闭 | 打开 | 关闭 | `settle(true)` |
| D4 设置页返回 | 设置页 | 工作区或导航 | 路由变化接管，续播至返回目标 |
| D5 导航打开 | 关闭 | 打开 | `settle(false)` |

`pointerup` 后 hook 已回到空闲，收尾动画最长一个全程时长，期间可能发生：

| 情况 | 处理 |
| --- | --- |
| 再次按下同一表面 | `settling()` 为真时 `start` 返回 `false`；触发式也不提交（`canSwipe` 返回 `false`） |
| 出现确认框或设备选择器，但表面仍打开 | 回弹到本次手势起点，不提交原动作，不把门禁受阻当成外部关闭 |
| 拖动或回弹收尾中，表面被按钮、Escape、`popstate` 关闭 | 根据上表从当前位置走到实际关闭目标，不再调用关闭函数。D1–D3 的 Mantine 退出过渡在 WAAPI 之下进行，结束后照常卸载；D4 交给路由转场；D5 依赖正常退出时长保持挂载，见 P4 |
| 提交收尾中又被外部关闭 | D1–D3 已在走向关闭终点，不重复调用关闭函数；D4 由路由接管；D5 中止打开收尾并改走关闭起点，旧收尾不得再启用焦点陷阱或滚动锁 |
| 表面卸载（切换会话、父级移除） | `dispose`，不再调用任何回调 |

### 关闭请求的接受与拒绝

现有 `requestClose()`、`closeBackgroundOverlay()` 返回 `void`，不能用返回值或调用后的旧 `opened` 值判断成功。P1、P2 沿用这些入口，以 React 提交后的实际打开状态确认结果：

1. 收尾到关闭终点后，保持 WAAPI 末帧；在同一回调里置位手势专用的即时退出标记、登记本次关闭请求序号，并调用关闭入口一次。
2. 在本次请求更新提交后的 `useLayoutEffect` 中确认结果：`opened === false` 表示接受；仍为 `true` 表示同步关闭门禁拒绝。请求序号是手势控制器自己的状态，在调用关闭入口前登记，保证拒绝时也有一次提交可观察。导航不复用、也不调整现有 `closeRequest`：它在设备选择器门禁之后才递增，且 `closeRequest > 0 && opened` 时会清空 `pendingActionRef`，提前递增会让被选择器拦下的关闭也清掉待执行动作。不通过超时或重复调用关闭入口猜测结果。
3. 接受时按既有关闭生命周期处理 history、焦点和阅读锁，静止态提交后再清理 WAAPI。拒绝时先撤销本次手势的即时退出标记，再 `settle(false)` 回弹；不触碰 history，之后按钮、Escape 或遮罩关闭仍使用正常退出时长。
4. 本次请求已被消费、表面换目标或卸载时，旧确认和动画回调均不得再执行。系统原生转场的即时标记与手势标记独立，拒绝时不得清除 `hasUAVisualTransition` 的处理结果。

该确认方式只适用于当前同步关闭门禁；若实现时发现关闭入口改为异步请求，须先明确接受／拒绝契约，不能把暂时仍打开直接当作拒绝。

### `swipe-guards.ts`

`swipeBlocked` 忽略带 `data-swipe-drag` 的叠层，避免导航打开拖动时新挂载的 `role="dialog"` 阻断自己的手势。该属性在收尾结束或取消时移除，不得残留。

## 分阶段实施

按风险从低到高，每阶段独立验证，不一次合并。

### P1：两个阅读器关闭（D1、D2）

- 文件：[`tool-reader.tsx`](../../../pwa/src/components/pwa/tool-reader.tsx)、[`published-file-reader.tsx`](../../../pwa/src/components/pwa/published-file-reader.tsx)、[`use-reader-history.ts`](../../../pwa/src/components/pwa/use-reader-history.ts)。
- 目标：`Drawer.Content`（translateX 0 → 100%）与 `.pwa-scrim`（opacity 1 → 0）。
- `use-reader-history` 增加 `skipExit()` 与 `resetSkipExit()`：前者置位手势专用的即时退出标记，使本次关闭使用 `exitDuration: 0`；后者只撤销该标记，不清除系统原生转场的即时状态。重新打开时两类状态按各自生命周期复位。
- 提交：`settle(true)` 完成后按「关闭请求的接受与拒绝」登记请求、调用 `skipExit()` 和关闭入口。文件阅读器仍走 `requestClose`，保留 `hasOtherModal` 检查；请求提交后仍打开时，调用 `resetSkipExit()` 再回弹。接受后，现有 effect cleanup 撤回 history 记录，现有退出完成回调释放阅读锁并恢复焦点；回弹不触碰这些关闭流程。
- 外部关闭：以实际 `opened === false` 为依据从当前位置走到终点，不单凭 `disabled` 推断关闭。带 `hasUAVisualTransition` 时 Drawer 已立即卸载，只需 `dispose`。
- 图片舞台 `data-swipe-ignore` 保持。

### P2：导航关闭（D3）

- 文件：[`session-sheet.tsx`](../../../pwa/src/components/pwa/session-sheet.tsx)。
- 目标：`.pwa-session-sheet`（translateX 0 → -100%）与遮罩；`extent` 取内容元素实际宽度。
- `SessionSheet` 内部新增手势专用的"仅退出即时"状态，只作用于 `exitDuration`；现有 `instant` 同时控制进入和退出，不复用。重新打开时复位，关闭请求被拒绝时立即撤销。
- 提交：`settle(true)` 后按「关闭请求的接受与拒绝」登记手势请求序号、置位退出即时并调用现有 `requestClose()`，以提交后的 `opened` 确认结果。`closeBackgroundOverlay` 拒绝关闭（确认框打开）时，先撤销退出即时再回弹；按下时 `swipeBlocked` 已拦截可见确认框，这里只兜底。
- 保留 `chooserOpenRef` 门禁：设备选择器打开时 `start` 返回 `false`。

### P3：设置页返回（D4）

- 文件：`use-page-transition.ts`、[`pwa-workspace-layout.tsx`](../../../pwa/src/components/pwa/pwa-workspace-layout.tsx)、新 hook `use-workspace-drag.ts`。
- `usePageTransition` 新增 `beginDrag / dragTo / settleDrag / handOff`：
  - 暂停动画登记到现有 `animationsRef`，拖动结束前不由拖动逻辑自行取消。
  - 提交：调用 `onSettingsBack()`。有 history 记录时等待 `popstate`；无记录（非 `/app` 页面）时由 `closeSettings` 直接更新路由。随后的路由变化走已有的"有运行中动画则读当前位置续播"分支，不重写转场。
  - 续播时长只在拖动交接时改用 `settleDuration(剩余位移, 松手速度, 全程时长)`；按钮连点、前进后退中途反向等现有续播保持全程时长。用一次性的交接标记区分来源。
  - 回弹：`settleDrag(false)`，与 P1 相同的 `settle` 语义。
- 拖动开始须揭示工作区层：新增 `settingsDragging` 状态并用 `flushSync` 置位，使 `data-view-transition` 生效（[`workspace-shell.css`](../../../pwa/src/app/workspace-shell.css) 靠它取消 `visibility: hidden`）；暂停动画在同一任务内创建，首帧工作区位于 `-width`。设置页 `useSwipe` 的 `enabled` 改为 `open && (!transitioning || settingsDragging)`。
- 外部关闭：拖动中收到 `popstate`（如 Android 返回键）且实际路由已返回时，`useSwipe` 的取消处理只清拖动状态，不得回卷或取消 `animationsRef` 里的动画，由 `usePageTransition` 的续播分支读取当前位置接管。正确性不依赖取消处理与转场 effect 的先后：取消处理只按实际路由判断、不触碰 `animationsRef`，拆到 `use-workspace-drag.ts` 后 hook 调用顺序变化也不影响；回归测试照常覆盖。单纯手势受阻、路由仍为设置页时则回弹。
- 来源为导航（`origin.kind === "navigation"`）时，拖动开始就按现有 change 块的做法预挂载导航（`sheetInstant`、`sheetRestore`、`sheetMounted`、`sheetOpen`）；导航 Portal 挂在 `.pwa-workspace-view`，随工作区层移动。此时工作区仍保持 `inert`，导航只是返回预览：暂缓 FocusTrap 和 `useNavigationSettingsFocus` 的主动聚焦，保留待处理的设置入口焦点请求，不在拖动中消费。
- 返回路由提交、工作区解除 `inert` 后，明确消费该焦点请求，聚焦导航内的设置入口；不依赖已经打开的 Drawer 再次自动初始化。Portal 内容若晚挂载，请求保留到目标可聚焦时执行；成功后只消费一次，普通重渲染不得抢回用户已移开的焦点。
- 回弹或路由等待超时后，清除预览与未消费的焦点请求，并复位四项导航状态：`setSheetOpen(false)`、`setSheetMounted(false)`、`setSheetInstant(false)`、`setSheetRestore(null)`。设置页继续打开，原焦点不变。
- 保险：提交后 1s 内路由未变化，撤销拖动动画并恢复设置页，避免卡死。之后若 `popstate` 迟到，按普通返回从设置页完整播放返回转场，属预期。
- 拖动状态全部放在 `use-workspace-drag.ts`，不堆进布局文件。

### P4：导航打开（D5，风险最高，最后做）

- 文件：`pwa-workspace-layout.tsx`、[`pwa-mobile-chrome.tsx`](../../../pwa/src/components/pwa/pwa-mobile-chrome.tsx)、`session-sheet.tsx`、`swipe-guards.ts`。
- 拖动开始：在 `flushSync` 中复用现有 `openNavigation()`，焦点来源固定为主区 `.pwa-session-trigger`，同时登记 `sheetFocusOrigin`、`sheetMounted`、`sheetOpen` 与"拖动中"标记。同一任务内对 `.pwa-session-sheet`（translateX -100% → 0）与遮罩（opacity 0 → 1）建暂停动画，progress 为 0，保证首帧在屏幕外；给内容打 `data-swipe-drag`。须用测试确认 `flushSync` 返回时 Portal 内容已挂载（Mantine `Portal` 在 layout effect 中挂载）。
- D5 使用"仅进入即时"，只把进入 `duration` 置零，不复用同时影响进出的 `instant`。退出保持正常 Drawer 时长；仅当 WAAPI 已到关闭起点后，才使用 P2 的"仅退出即时"完成静止态提交。
- 拖动及打开收尾期间关闭焦点陷阱和滚动锁：`SessionSheet` 在该预览态传 `trapFocus={false}`、`lockScroll={false}`（Mantine 的焦点陷阱为 `opened && trapFocus`），焦点不离开原处，移动端键盘不在拖动中收起。
- 主区 `useSwipe` 的 `enabled` 只豁免本次拖动自己设置的 `sheetOpen`，其余门禁仍有效。
- 提交：`settle(true)` 成功且业务状态仍打开时，清除预览标记，焦点陷阱与滚动锁随之启用，初始焦点按现有规则进入导航；复位进入即时，打开静止态提交后再 `dispose`。之后正常关闭仍使用已登记的导航入口恢复焦点。
- 回弹：`settle(false)` 后在同一更新中置位退出即时、置位"跳过回焦"并 `setSheetOpen(false)`，等关闭静止态提交后清理标记和 WAAPI。沿用现有生命周期，导航关闭后保持组件挂载、不额外卸载。未提交的打开手势保留原焦点：现有 `handleExitTransitionEnd` → `restoreFocus()` 在 `document.activeElement` 为 body 时会把焦点移到 `.pwa-session-trigger`，"跳过回焦"标记使本次退出不执行 `restoreFocus()`，消费后立即清除，不影响之后的正常关闭。
- 外部关闭：业务 `sheetOpen` 变为 `false` 时，中止打开收尾，从当前位置 `settle(false)` 到关闭起点，不再次调用关闭入口。不另设显示态保留标记：D5 的退出保持正常 Drawer 时长，Mantine 在两个 rAF 加退出时长之后才卸载内容，而 `settleDuration` 上限为同一全程时长，收尾期间内容与遮罩仍挂载；以测试断言该时序。`opened` 已为 `false`，焦点陷阱与滚动锁不会启用。旧打开收尾回调不得提交打开态；若父级直接移除表面，则只 `dispose`。
- 拖动进行中的外部关闭：`sheetOpen` 变为 `false` 后主区 `useSwipe` 的 `enabled`（`!sheetOpen`）反而重新成立，hook 不会发出取消。控制器发现外部关闭后把本次手势标为作废，忽略其后续 `move`，`end` 到达时不提交、不调用打开入口，避免同一指针松手时再打开导航；作废标记在本次 `end` 或取消时清除。
- 已知风险：在 Mantine 内切换 `trapFocus` 与 `lockScroll` 的时序，以及 iOS 上滚动锁晚启用的表现。真机表现不稳时，是否允许 D5 保留触发式并在 DESIGN 写明例外，见「待确认」。

## 可选项：视差与阴影

**2026-10-08 已被取代：** 设置页改为与右侧 Drawer 同一覆盖模型（工作区不动，设置层带 `--pwa-shadow-modal` 滑入，`scrim` 遮罩同步淡化），见「实现记录（2026-10-08）」；不再采用下述视差方案。

原方案：默认不做。仅当真机对比系统手势后差距明显才启用：设置页返回时工作区层只移动约 30% 宽度，并给设置页加左侧阴影。这会改变 [DESIGN](../../DESIGN.md) 中设置页"整页水平推入／返回"的规则，须单独评估。提交阈值改为"位移 ≥ 40% 宽度或速度达标"、弹簧曲线近似同属此类，不在首版范围。

## 测试

沿用 `pwa/src/test/browser/swipe.ts` 的 CDP 触摸工具。

- 纯函数（`swipe-gesture.node.test.ts`）：`lockOffset` 无跳变；`trackedDistance` 反向时夹到 0；越过阈值后反向甩回 `reversed` 为真；`settleDuration` 上下限。
- `useSwipe` + `drag`（`use-swipe.browser.test.tsx`）：`start / move / end` 调用顺序，`start` 在捕获成功后调用；`start` 返回 `false` 时退回触发式；多指、媒体查询变化、`pointercancel` 发出 `interrupted`；`canSwipe()` 变为 `false` 或出现阻断叠层时发出 `blocked`；`enabled` 变为 `false` 发出 `disabled`。取消原因不替代表面的实际打开状态。
- `swipe-drag`：easing 为计算值而非 `var()`；`settle` 末帧保持；`dispose` 中止时 resolve `false`。
- 各阶段（CDP 真实触摸）：
  - 触摸中途不松手，断言面板位置随手指变化，位置按整像素（`Math.round`）比较。
  - 松手越过阈值：动画完成后回调恰好一次，状态正确，卸载前无闪回帧。
  - 松手未过阈值或反向甩回：回弹，状态不变，无残留动画和 `data-swipe-drag`。
  - 拖动中反向、竖向滚动、减少动态效果、`touchcancel`、左缘起点（模拟非 standalone）。
  - 收尾期间再次按下不启动新拖动；回弹收尾中点关闭按钮，从当前位置走到各表面的实际关闭目标，不跳回错误端点。
  - 拖动中出现确认框或设备选择器：底层仍打开时回弹，不调用关闭入口、不改 history；取消与实际关闭同一更新发生时，以实际关闭状态交接。
  - P1、P2 在关闭收尾期间新增关闭阻断条件：关闭请求只调用一次，请求提交后确认拒绝并回弹，即时退出标记清除、history 保持；随后正常按钮关闭仍有完整退出动画。分别覆盖文件阅读器的 `hasOtherModal` 和导航的 `closeBackgroundOverlay`，后者使用真实确认门禁，不能以无条件关闭的测试替身代替。
  - 拖动中触发 `popstate`（模拟 Android 返回键）：P1 从当前位置关闭，P3 返回转场从当前位置续播。
  - P3 另测来源为导航与工作区两种返回、导航来源回弹后四项状态及待处理焦点请求复位、`popstate` 超时保险。
  - P3 从导航来源返回时，保持跟手拖动，覆盖预挂载后的异步焦点初始化时机：预览门禁阻止聚焦，焦点仍留在设置页；提交并解除工作区 `inert` 后，焦点落到导航内的设置入口。用可观察的生命周期或任务屏障确认初始化时机，不用短计时器猜测。另测晚挂载只消费一次请求，回弹或超时不留下后续抢焦点的请求。
  - P4 另测拖动中焦点不移动、提交后焦点进入导航且滚动锁生效、回弹后焦点与 body 滚动均未改变；回弹分别覆盖起始焦点在其他元素和 `document.activeElement` 为 body 两种情况，后者焦点不得落到 `.pwa-session-trigger`。首次通过拖动打开再正常关闭，焦点回到 `.pwa-session-trigger`。
  - P4 在拖动中及提交收尾中外部关闭：面板从当前位置朝关闭起点移动，收尾完成前内容与遮罩仍挂载（断言 Mantine 卸载晚于 `settle` 完成），不朝打开终点移动、不瞬间消失；旧打开回调不启用焦点陷阱或滚动锁；拖动中外部关闭后继续移动并松手，导航不重新打开；关闭后无残留作废标记、动画或 `data-swipe-drag`。
- 等待用 `vi.waitFor` 与动画 `finished`，不用短计时器，为 Linux CI 留余量。
- 现有 `mobile-swipe`、`navigation-swipe`、`reader-swipe` 三个测试里"松手立即断言"的用例改为等待动画结束。

## 验收与交付

- 每阶段运行 `pnpm --filter pwa typecheck`、`pnpm --filter pwa lint`、受影响的 browser 测试和 `git diff --check`；全部阶段完成后运行 `pnpm verify`。
- iOS／Android 真机须人工验收，与触发式方案的真机矩阵合并：边缘手势与应用内拖动不冲突（含 iOS Safari 边缘起手页面是否先收到事件、边缘排除宽度）；`touch-action: pan-y` 下拖动不被浏览器接管；iOS standalone 是否真的没有系统边缘返回。
- 完成后同步 [DESIGN](../../DESIGN.md) 的「移动端滑动」（"不跟手拖动"的表述、触摸动作说明、边缘排除）与设置页相关段落，并更新 ROADMAP，再归档本方案。
- 工程约束：`pwa-workspace-layout.tsx` 现 221 行，拖动状态放入新 hook；`pwa-app.tsx` 已超 600 行，不往里加逻辑。
- 不自动 commit、push 或发布。

## 实现记录（2026-10-07）

P1–P4 已按本方案实现并通过自动化验证，真机验收未做。实现与方案的差异：

- **CSS 过渡压过 WAAPI。** 方案假设 WAAPI 层级高于 Mantine 的过渡，实测 CSS transition 的层叠优先级高于脚本动画，外部关闭时面板会先跳回 0 再滑出。`swipe-drag` 在动画存续期间给目标元素加 `data-swipe-drag-active`，`workspace-navigation.css` 对它设 `transition: none !important`。
- **进入时长 0 的 Drawer 会重挂载。** D5 为同步挂载使用 `duration: 0`，之后非零退出开始时 Mantine 会重挂载内容，暂停动画所在元素被替换。因此 D5 的外部关闭不再依赖 Mantine 退出过渡接续：预览态期间 Drawer 保持显示（`opened = sheetOpen || gesture === "dragging"`），WAAPI 走到关闭起点后再即时关闭；手势期间进入时长同时置 0，避免 Mantine 按进入时长延迟释放的滚动锁状态在手势结束后短暂亮起。
- **设置页返回不经 `settle(true)`。** 控制器登记的是 `SwipeDrag` 对象而非 `animationsRef` 里的动画；路由变化时 `usePageTransition` 读位置、dispose 拖动并以 `settleDuration` 续播。
- **边缘排除与 `start` 参数。** 左缘排除由 `useSwipe` 在调用 `drag.start` 前判断（`drag.start` 拿不到起点坐标），效果等同于 `start` 返回 `false`。

## 实现记录（2026-10-08）

设置页转场与 D4 返回拖动改为覆盖模型，与工具／文件阅读器的 Drawer 一致：

- `usePageTransition` 与 `useWorkspaceDrag` 只驱动设置层位移和新增的 `.pwa-page-scrim` 透明度，工作区层不再移动；续播从设置层位置与遮罩透明度读取当前状态。减少动态效果仍为工作区与设置层的交叉淡化。
- 遮罩位于设置层下方，只随设置页挂载，静止透明且不拦截点击；设置层仅在 `data-view-transition` 期间带 `--pwa-shadow-modal`。
- 从导航进入或返回导航时，导航随工作区保持原位，被设置页覆盖或露出。

## 待确认

- ~~是否授权在 ROADMAP 登记本事项，并在实现时更新 DESIGN。~~ 已授权并完成（2026-10-07）。
- 现象 1、2 的观测环境：iOS Safari 标签页还是 standalone，以及 iOS 版本。
- ~~是否在[触发式方案](20261005-mobile-swipe-gestures.md)的非目标处补一条指向本方案的替代说明。~~ 已补。
- P4 在真机不稳时，是否允许 D5 保留触发式并在 DESIGN 写明例外。
- ~~视差与阴影是否作为 P3 的可选项，在真机验收后再决定启用。~~ 已改为覆盖模型（2026-10-08），不再采用视差。
- 2026-10-08 用户反馈添加到主屏的 standalone 下仍出现系统返回动画，设备、系统版本与触发方式未记录；会影响左缘排除是否需要覆盖 standalone。
