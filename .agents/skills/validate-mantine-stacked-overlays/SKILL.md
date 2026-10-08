---
name: validate-mantine-stacked-overlays
description: 在 Pi Reach PWA 中实现或审查 Mantine Modal、Drawer、Menu、Popover、Notifications，以及涉及 Portal、焦点返回、Escape 竞争、滚动锁或叠层交接的手势和页面转场时使用。仅改文案、纯视觉建议或后端协议任务不使用。
---

# 验证 Mantine 叠层

## When to Use

- 新增或调整叠层，或修改其打开、关闭、动作交接、异步 pending、焦点来源和 Portal 目标。
- 修改移动导航、阅读器、设置页返回或跟手预览，可能影响焦点陷阱、`inert`、滚动锁和退出生命周期。
- 本技能是项目 overlay 验证的主入口，不替代前端实现、独立审查或子代理编排流程。上游先冻结本轮范围；本技能输出受影响验证矩阵、结果与未覆盖风险。
- 只读审查不授权改文件。实现、迁移、删除、提交、部署及真实破坏性操作仍分别遵守用户授权与项目规则。

## Procedure

1. 先读[根项目规范](../../../AGENTS.md)、[PWA 规范](../../../pwa/AGENTS.md)与[当前设计](../../../docs/DESIGN.md)，核对目标组件、真实父组件、主题、样式和直接测试。按风险选择下方矩阵，不从历史方案推断当前结构；版本与行为从当前依赖、类型和实现取得。
2. 盘点叠层的所属根、Portal 父节点、层级、遮罩、焦点陷阱、滚动锁及关闭入口。一般 Portal 位于 `.pwa-root` 内；移动导航挂在 `.pwa-workspace-view` 内随设置页转场移动。层级与单层遮罩按 DESIGN 验证，不能机械要求 Modal 高于 Toast。
3. 保持依赖 Mantine `returnFocus` 的 Modal 实例可观察到 `opened` 的打开到关闭变化，不在关闭时直接卸载整个实例。调用需要新叠层的动作前记录有效焦点来源与动作专属后备控件；复用既有同步 ref、确认门禁和动作路由，不另建平行状态机。
4. 关闭后的焦点先检查 Mantine 是否已返回有效控件；只有焦点仍在 body、html、旧 Dialog 或已失效来源时才补救。候选须已连接、可见、可用、非 `inert` 或 `aria-hidden`，使用 `preventScroll` 聚焦；不得覆盖用户已移到有效控件的焦点。按组件既有关闭开始、退出结束或卸载生命周期执行，不统一延迟到任意一帧。
5. 验证最上层独占本次 Escape、遮罩及关闭动作。Modal 叠在 Drawer 时，底层同步门禁不得因 React 闭包滞后而一起关闭；连续逐层 Escape 则按实际事件转发与既有契约消费，不能靠短计时器或退出中的 DOM 长期阻挡下一次按键。
6. 异步确认沿用同步 pending ref 防快速双击，并在既有结束路径解锁。pending 期间确认、取消、关闭、Escape、遮罩及相关布局重置均服从门禁；失败留在正确上下文，不提前执行业务动作。退出后交接动作先取走并清空 pending，确保正常退出与卸载清理至多执行一次。
7. 跟手与页面转场验证预览、提交、回弹、外部关闭与晚挂载的交接：预览不抢焦点、不启用滚动锁；解除 `inert` 后明确消费待处理焦点请求一次。关闭被拒绝须撤销手势专用即时退出标记；取消原因不能替代实际打开状态。WAAPI 末帧保留到 React 静止态提交后再清理，旧回调不得影响快速重开。
8. 涉及 Notifications 时读当前版本类型和源码，核对自动关闭、拖拽、滚动关闭、store、固定 ID 与队列行为。队列及优先级按 DESIGN 和现有控制器验证，不把 `limit=1` 当作禁用队列；空通知不占布局，关闭或 Portal 目标变化后焦点与实例生命周期有效。
9. 自动化覆盖动作路由、副作用顺序、失败保持、并发锁、背景门禁与真正关闭态。测试走真实父组件路径，不让 fixture 提前关闭底层而伪造通过。非视觉行为优先 Browser Mode；视觉、点击命中和生产样式再用隔离浏览器补证，不执行真实清库、删除配对或创建会话等破坏性确认。

## Pitfalls

- 截图、SSR 无 Dialog HTML、隐藏角色查询或焦点提前返回，都不能单独证明退出结束、组件实例常驻或同步门禁已释放；等真实 DOM 卸载或明确退出信号。
- 阅读器 history 标记可能早于 Portal 挂载。系统返回测试先等真实 Dialog 可见，再触发返回；返回后先等 history 标记清除，再确认 DOM 卸载。否则把尚未挂载误判为已关闭，提前 cleanup 可触发第二次 `history.back()` 并退出测试页面。
- `renderPwa` 提供测试根，真实 PwaApp 集成路径不得再套额外同名 `.pwa-root`；核对实际父节点。Mantine 可能重写 `aria-labelledby`，先查真实可访问名称，再限定容器或精确定位。
- 浏览器点击不保证触发器先成为 `document.activeElement`；验证回焦前显式 focus，再 click。短 accessible name 可能匹配关闭按钮，不猜定位器。
- 从 Drawer 打开非 Portal 或低层级子 Modal，可能被底层覆盖；按已确认流程先完成 Drawer 退出，或使用正确 Portal 与层级，不能静默改动作交接规则。
- `Drawer.Content` 的 class 可能同时落在 inner 与 content；尺寸、纵向 flex 和定位用实际节点与 Styles API 核对。Group 的内联 flex 可能覆盖低特异性移动 CSS，检查 computed style 而不只看截图。
- 全屏外框高度不证明正文可滚动。核对 content 的纵向 flex、header 不收缩、正文 `min-height: 0` 与剩余高度；使用超出视口的真实内容实际滚到末尾，再验焦点和关闭。
- 独立 Browser 测试加载所需组件样式；字体与 font 简写使用有效系统字体 fallback。当前工程是 Vite，不使用不存在的 Next.js 生成类型或旧设置抽屉约束。
- 暂停动画、一个 rAF 或动画 `finished` 不证明 React 已提交；不以短 sleep 放宽竞态断言。几何按整像素比较，等待使用可观察状态并给慢机器留余量。
- DOM 自动清理不等于异步 history 清理完成；测试在卸载和切换用例前等待所属历史记录撤回，按夹具恢复 URL 与 `history.state`。单文件通过不能排除跨文件生命周期竞态。
- 桌面 Chromium 的移动 viewport 或 CDP 触摸不替代 iOS、Android 真机的键盘、安全区、边缘返回及滚动锁验收。

## Verification

按本轮受影响入口选择并记录适用项，未触及的流程不机械全跑：

| 风险面 | 必须观察的结果 |
| --- | --- |
| 设置页确认 | 当前设置是 `/app/settings` 页面，不是 Drawer；确认位于正确根内，Escape 只关闭确认并返回有效设置控件，不触发底层返回 |
| 导航删除确认 | 取消保留底层导航并回到电脑管理入口；成功删除使来源消失时仍有有效后备焦点；遮罩与层级符合 DESIGN |
| 电脑选择器与导航 | 正常动效与 Reduced Motion 下连续发送 Escape，不等待退出动画也能按契约逐层关闭，不重复路由或泄漏按键 |
| Modal、菜单与信息 Popover | 打开焦点、Tab、Escape 回焦、外部关闭不抢焦点；只读信息保持 dialog 语义；异步更新与快重开不继承旧焦点或动作 |
| 阅读器 | 真实打开态、系统返回、按钮／Escape／遮罩关闭、history 撤回、阅读锁与 pin 释放、来源移除后的后备焦点均按既有生命周期完成 |
| 跟手与设置返回 | 预览不抢焦点或锁滚动，提交正确启用，回弹无残留；外部关闭从当前位置交接，拒绝后正常关闭仍有退出动画；晚挂载及已挂载导航均只消费一次焦点请求 |
| 桌面侧栏收起 | 仅重置所属 Portal 控件，不卸载会话或导航滚动区；Popover／Menu 打开时收起再展开，旧浮层不重现且焦点有效 |
| 窄屏与短横屏 | Dialog 在视口内，按钮布局与点击域有效；真实正文可滚到最后一项；动态提示不遮挡输入和时间线 |
| Toast 与提示共存 | 固定 ID、展示条数、队列及优先级符合现有控制器；连接 banner、局部错误、SW 提示同时出现时测正文或 Range 边界与点击命中，结合截图验可用面积 |

- 命令真源是根与 PWA 的 `package.json`、`vitest.config.ts` 和 `playwright.config.ts`。执行受影响 Node／Browser Mode 测试与 PWA lint；涉及类型或生产产物时再运行 typecheck／build，关键跨模块流程增加对应 Playwright。最终运行 `git diff --check`，不据纯技能或文字变更宣称业务测试通过。
- 现有目标测试可从 `pwa/src/components/pwa/` 中的 `session-sheet`、`confirm-action-dialog`、`rename-pairing-dialog`、`workspace-device-control`、`pwa-workspace-layout`、`published-file`、`message-list` 与 swipe／drag 浏览器测试定位；先确认文件存在，不固定测试数量。
- 缺少真实 DOM runner 或真机证据时报告未覆盖风险；结构门禁和截图只作补充，不能当作 transition、history、焦点或设备验收已通过。
- 触及授权外流程、共享契约冲突、真实数据或环境阻塞时停止并报告，不扩大写入、提交或部署范围。
