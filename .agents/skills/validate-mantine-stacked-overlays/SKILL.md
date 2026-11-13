---
name: validate-mantine-stacked-overlays
description: 在 Pi Reach PWA 中实现或审查 Mantine Modal、Drawer、Menu、Popover、Notifications 与阅读器，以及涉及 Portal、层级 token、焦点返回、Escape 竞争、滚动锁或叠层交接的手势、页面转场、桌面快捷键和侧栏调宽时使用。仅改文案、纯视觉建议或后端协议任务不使用。
---

# 验证 Mantine 叠层

## When to Use

- 新增或调整叠层，或修改其打开、关闭、动作交接、异步 pending、焦点来源、Portal 目标和层级。
- 修改移动导航、阅读器、设置页返回或跟手预览，可能影响焦点陷阱、`inert`、滚动锁和退出生命周期。
- 修改桌面快捷键、侧栏收展或调宽，可能与打开的叠层争夺按键、焦点或指针。
- 本技能是项目 overlay 验证的主入口，不替代前端实现、独立审查或子代理编排流程。上游先冻结本轮范围；本技能输出受影响验证矩阵、结果与未覆盖风险。
- 只读审查不授权改文件。实现、迁移、删除、提交、部署及真实破坏性操作仍分别遵守用户授权与项目规则。

## Procedure

1. 先读[根项目规范](../../../AGENTS.md)、[PWA 规范](../../../pwa/AGENTS.md)与[当前设计](../../../docs/DESIGN.md)的「叠层」「布局与导航」「移动端滑动」「设置页」「桌面键盘」，核对目标组件、真实父组件、主题、样式和直接测试。按风险选择下方矩阵，不从历史方案推断当前结构；版本与行为从当前依赖、类型和实现取得。
2. 盘点叠层的所属根、Portal 父节点、层级、遮罩、焦点陷阱、滚动锁及关闭入口。全部叠层 Portal 到 `.pwa-root`；移动导航挂在 `.pwa-workspace-view` 内，设置页转场时随工作区保持原位、被设置层覆盖。层级只取 DESIGN「叠层」表中的 `--pwa-z-*`（Mantine `zIndex` 传同名 `var()`），新增叠层先归入已有层，由 `pwa-layer-guard` 校验；遮罩始终只有一层，不能机械要求 Modal 高于 Toast。
3. 保持依赖 Mantine `returnFocus` 的 Modal 实例可观察到 `opened` 的打开到关闭变化，不在关闭时直接卸载整个实例。调用需要新叠层的动作前记录有效焦点来源与动作专属后备控件；复用既有同步 ref、确认门禁和动作路由，不另建平行状态机。
4. 关闭后的焦点先检查 Mantine 是否已返回有效控件；只有焦点仍在 body、html、旧 Dialog 或已失效来源时才补救。候选须已连接、可见、可用、非 `inert` 或 `aria-hidden`，使用 `preventScroll` 聚焦；不得覆盖用户已移到有效控件的焦点。按组件既有关闭开始、退出结束或卸载生命周期执行，不统一延迟到任意一帧。所属层还带着子叠层退出时（如设置页返回时快捷键帮助随设置层卸载），在该层及其子叠层真正卸载后再恢复入口焦点，否则子 Modal 的焦点清理会覆盖刚恢复的焦点。
5. 验证最上层独占本次 Escape、遮罩及关闭动作。Modal 叠在 Drawer 或阅读器上时，底层同步门禁不得因 React 闭包滞后而一起关闭；连续逐层 Escape 则按实际事件转发与既有契约消费，不能靠短计时器或退出中的 DOM 长期阻挡下一次按键。页面级快捷键在叠层打开时暂停，不得越过叠层操作被覆盖的工作区。
6. 异步确认沿用同步 pending ref 防快速双击，并在既有结束路径解锁。pending 期间确认、取消、关闭、Escape、遮罩及相关布局重置均服从门禁；失败留在正确上下文，不提前执行业务动作。退出后交接动作先取走并清空 pending，确保正常退出与卸载清理至多执行一次。
7. 阅读器（工具、文件、摘要、Thinking）共用 `ReaderShell` 与 `useReaderSelection`：打开与退出期间互斥，owner token 隔离旧过渡回调，阅读锁持有到真实退出；每次打开只占一条 history，Back 只关闭阅读器。改动其中一种时核对其余阅读器与已发布图片的放大过渡层。
8. 跟手与页面转场验证预览、提交、回弹、外部关闭与晚挂载的交接：预览不抢焦点、不启用滚动锁；解除 `inert` 后明确消费待处理焦点请求一次。关闭被拒绝须撤销手势专用即时退出标记；取消原因不能替代实际打开状态。WAAPI 末帧保留到 React 静止态提交后再清理，旧回调不得影响快速重开。Drawer 与设置页的进出时长与弹簧以 DESIGN「动效」为准，等待退出用可观察信号，不按旧时长写死。设置页转场途中被按钮或系统返回打断时沿用当前速度折返，返回方向不得越过左缘露出工作区。跟手手势按投影停点提交（停点过行程一半）：测试用停稳后松手或指定事件时间戳固定松手速度，不让提交与否随机器快慢变化；底部电脑面板的下拉关闭与左右 Drawer 共用同一控制器，下方的导航 Drawer 不算阻断叠层；Toast 反向越过原位时带阻尼跟随并弹回；贴边的电脑选择底部面板、左右 Drawer、设置页与移动导航反向越过原位时硬停。
9. 涉及 Notifications 时读当前版本类型和源码，核对自动关闭、拖拽、滚动关闭、store、固定 ID 与队列行为。Mantine 自带的横向拖动与滚动关闭保持关闭；触屏上滑收走由 `use-toast-swipe-dismiss` 实现，提交走关闭按钮的同一入口，固定 ID 的下一条提示复用同一元素时不得带着上一条的位移。队列及优先级按 DESIGN 和现有控制器验证，不把 `limit=1` 当作禁用队列；空通知不占布局，关闭或 Portal 目标变化后焦点与实例生命周期有效。
10. 自动化覆盖动作路由、副作用顺序、失败保持、并发锁、背景门禁与真正关闭态。测试走真实父组件路径，不让 fixture 提前关闭底层而伪造通过。非视觉行为优先 Browser Mode；视觉、点击命中和生产样式再用隔离浏览器补证，不执行真实清库、删除配对或创建会话等破坏性确认。

## Pitfalls

- 截图、SSR 无 Dialog HTML、隐藏角色查询或焦点提前返回，都不能单独证明退出结束、组件实例常驻或同步门禁已释放；等真实 DOM 卸载或明确退出信号。
- 异步详情取消与 Drawer 退出不是同一时刻。取消订阅时直接清空已展示正文，会在退出中闪回“加载中”；退出展示可保留最后匹配身份的快照。更换选择、作用域或 controller 时保留旧快照又会形成跨上下文闪现，不能为平滑退出削弱原有身份隔离。
- 阅读器 history 标记可能早于 Portal 挂载。系统返回测试先等真实 Dialog 可见，再触发返回；返回后先等 history 标记清除，再确认 DOM 卸载。否则把尚未挂载误判为已关闭，提前 cleanup 可触发第二次 `history.back()` 并退出测试页面。
- `renderPwa` 提供测试根，真实 PwaApp 集成路径不得再套额外同名 `.pwa-root`；核对实际父节点。Mantine 可能重写 `aria-labelledby`，先查真实可访问名称，再限定容器或精确定位。
- 浏览器点击不保证触发器先成为 `document.activeElement`；验证回焦前显式 focus，再 click。短 accessible name 可能匹配关闭按钮，不猜定位器。
- 从 Drawer 打开非 Portal 或低层级子 Modal，可能被底层覆盖；按已确认流程先完成 Drawer 退出（如移动导航进入配对／重命名），或使用正确 Portal 与层级，不能静默改动作交接规则。
- `Drawer.Content` 的 class 可能同时落在 inner 与 content；尺寸、纵向 flex 和定位用实际节点与 Styles API 核对。Group 的内联 flex 可能覆盖低特异性移动 CSS，检查 computed style 而不只看截图。
- 全屏外框高度不证明正文可滚动。核对 content 的纵向 flex、header 不收缩、正文 `min-height: 0` 与剩余高度；使用超出视口的真实内容实际滚到末尾，再验焦点和关闭。
- 独立 Browser 测试加载所需组件样式；字体与 font 简写使用有效系统字体 fallback。
- Menu 与 Popover 以触发按钮为原点缩放进出，命令菜单切换子视图时面板高度另有过渡（期间 `overflow: hidden`）：量几何、命中区或滚动前先等不透明度到 1、`getAnimations()` 为空，不在进入途中断言尺寸。
- 越界阻尼只用于不贴屏幕边缘的表面（Toast）。左右 Drawer、设置页、移动导航和贴底边的电脑选择底部面板朝关闭的反方向越过原位时必须停在原位：先朝关闭方向拖过方向锁定，再反向拖过起点，核对表面贴边的一侧仍与屏幕边缘重合，不露出背后内容。
- 暂停动画、一个 rAF 或动画 `finished` 不证明 React 已提交；不以短 sleep 放宽竞态断言。几何按整像素比较，等待使用可观察状态并给慢机器留余量。
- DOM 自动清理不等于异步 history 清理完成；测试在卸载和切换用例前等待所属历史记录撤回，按夹具恢复 URL 与 `history.state`。单文件通过不能排除跨文件生命周期竞态。
- 侧栏调宽使用 pointer capture，指针拖动不得抢走键盘焦点；按 DESIGN「侧栏宽度」列出的 Escape、失焦、收起、进入设置或切到移动布局等时机取消本次拖动，不保存半次宽度。
- 桌面 Chromium 的移动 viewport 或 CDP 触摸不替代 iOS、Android 真机的键盘、安全区、边缘返回及滚动锁验收；普通浏览器也不替代已安装桌面窗口的原生标题栏验收。

## Verification

按本轮受影响入口选择并记录适用项，未触及的流程不机械全跑：

| 风险面 | 必须观察的结果 |
| --- | --- |
| 设置页确认与帮助 | 当前设置是 `/app/settings` 页面，不是 Drawer；确认与快捷键帮助位于正确根内，Escape 只关闭最上层并返回有效设置控件，不触发底层返回；带着帮助返回工作区时，入口焦点在设置层卸载后仍有效 |
| 删除配对确认 | 取消保留底层导航并回到电脑管理入口；成功删除使来源消失时落到已定义的后备入口；遮罩与层级符合 DESIGN |
| 电脑面板与导航 | 桌面为 Portal Popover、移动为底部 Drawer，操作菜单位于面板之上；入口完成提示按 DESIGN 排除当前电脑，显隐不改变名称宽度，开关面板不确认提醒，切换电脑后即时重算；选择电脑不抢焦点，外部点击关闭不夺走其他控件焦点；正常动效与 Reduced Motion 下连续发送 Escape，不等待退出动画也能按契约逐层关闭，不重复路由或泄漏按键 |
| Modal、菜单与信息 Popover | 打开焦点、Tab、Escape 回焦、外部关闭不抢焦点；输入区命令、附件与模型菜单在设置层滑入时被覆盖；会话信息保持非模态 dialog 语义；异步更新与快重开不继承旧焦点或动作；触屏上点浮层之外只关闭它，不触发下方控件、不移动焦点，点自己的触发器照常收起，鼠标外部点击仍作用于被点控件；移动端确认弹窗确认在上、取消在最下，DOM 顺序与视觉一致 |
| 阅读器 | 真实打开态、系统返回、按钮／Escape／遮罩关闭、history 撤回、阅读锁与 pin 释放、来源移除后的后备焦点均按既有生命周期完成；上层 Modal 先独占 Escape，下一次 Escape 才关闭阅读器；视口变化不重建正文 DOM；四类阅读器互斥，图片放大过渡层高于阅读器 |
| 跟手与设置返回 | 预览不抢焦点或锁滚动，提交正确启用，回弹无残留；停稳松手不过半回弹、过半提交，短促轻扫提交；外部关闭从当前位置交接，拒绝后正常关闭仍有退出动画；晚挂载及已挂载导航均只消费一次焦点请求；底部电脑面板下拉关闭在正文溢出时只由头部触发，图片阅读器未缩放时下拉关闭、已缩放时单指为平移 |
| 桌面快捷键 | 输入控件、可编辑内容、菜单、弹窗、阅读器打开或页面转场时，页面级快捷键暂停；设置页只响应帮助；帮助关闭后回到有效来源或无来源时的后备焦点 |
| 桌面侧栏收展与调宽 | 收起仅重置所属 Portal 控件，不卸载会话或导航滚动区；Popover／Menu 打开时收起再展开，旧浮层不重现且焦点有效；调宽拖动被 Escape、失焦、收起或进入设置取消时不保存半次宽度，命中区不抢收展入口与滚动条 |
| 已安装桌面窗口 | 阅读器、Modal 及其遮罩覆盖整页（含品牌行与会话标题区）；原生标题栏外观与控件只用真实安装窗口核验 |
| 窄屏与短横屏 | Dialog 在视口内，按钮布局与点击域有效；真实正文可滚到最后一项；动态提示不遮挡输入和时间线 |
| Toast 与提示共存 | 固定 ID、展示条数、队列及优先级符合现有控制器；连接 banner、局部错误、SW 提示同时出现时测正文或 Range 边界与点击命中，结合截图验可用面积；触屏上滑收走后关闭回调照常触发，下一条提示在原位出现 |

- 命令真源是根与 PWA 的 `package.json`、`vitest.config.ts` 和 `playwright.config.ts`。执行受影响 Node／Browser Mode 测试与 PWA lint；改动层级、叠层组件或其 CSS 时运行 `pwa-layer-guard` 等静态守卫；涉及类型或生产产物时再运行 typecheck／build，关键跨模块流程增加对应 Playwright。最终运行 `git diff --check`，不据纯技能或文字变更宣称业务测试通过。
- 叠层组件清单（直接引入 Mantine Modal、Drawer、Menu、Popover 或 Notifications 的产品组件，由 `scripts/overlay-skill-guard.test.mjs` 与源码双向核对；增删叠层组件时同步本行与上方矩阵）：`composer-command-menu`、`message-composer`、`session-actions-menu`、`workspace-device-control`、`session-sheet`、`reader-shell`、`published-file-reader`、`confirm-action-dialog`、`pairing-dialog`、`rename-pairing-dialog`、`keyboard-shortcuts-dialog`、`pwa-operation-notifications`。
- 现有目标测试可从 `pwa/src/components/pwa/` 定位：设置与帮助看 `settings-page`、`pwa-workspace-layout`；确认与配对看 `confirm-action-dialog`、`pairing-dialog`、`rename-pairing-dialog`；电脑面板、导航与标题区看 `workspace-device-control`、`session-sheet`、`session-actions-menu`、`workspace-title-bar`；阅读器看 `reader-drawer`、`summary-reader`、`thinking-reader`、`published-file`、`published-image-motion`；侧栏看 `sidebar-width`；通知看 `pwa-operation-notifications`、`pwa-notice-layout`、`toast-swipe-dismiss`；时间线看 `message-list`；手势看 swipe／drag 浏览器测试与 `device-sheet-drag`；触屏外部点按看 `outside-tap-guard`。先确认文件存在，不固定测试数量。
- 缺少真实 DOM runner 或真机证据时报告未覆盖风险；结构门禁和截图只作补充，不能当作 transition、history、焦点或设备验收已通过。
- 触及授权外流程、共享契约冲突、真实数据或环境阻塞时停止并报告，不扩大写入、提交或部署范围。
