# 变更记录

## 0.0.3

- 新增随包分发的 DESIGN.md，归拢公共视觉与基础交互规则，区分现有能力、宿主接线与后续提取边界。
- 修正 0.0.2 README 漏掉手机限定的确认顺序描述：沿用既有规则，桌面取消在左、确认在右；手机确认在上、取消在下。按旧文档在桌面也确认优先的消费者需调整 JSX DOM 顺序，不能使用 CSS order；控件运行时 CSS 不变。
- README 补充正常关闭生命周期、焦点与异步门禁的规范引用；不新增业务弹窗包装，不改变 0.0.2 的运行时实现或已发布制品。

## 0.0.2

- 保留根 JS 与 foundation.css，新增可选 theme.css、controls.css、mantine 入口；新 peer 为可选精确版本 Mantine core/hooks 9.5.2、lucide-react 1.33.0。
- 提取中性明暗语义色、雾蓝强调色、系统字体与三档字号、间距/圆角/阴影和按钮/Modal 必要动效 token。
- 提取 Button、ActionIcon、TextInput、Textarea、Select、Modal 的基础外观；NativeSelect 复用同类输入规则，Drawer 只提供通用直角表面与标题。
- 提供主题工厂、语义 resolver、Modal transition/宽度与 SSR 安全动态时长 hook。palette 标识去品牌化为 pwaFoundation。
- Modal 遮罩类置于主题 classNames.overlay，避免传入 overlayProps 时因浅合并丢失默认遮罩；桌面不设置 xOffset，保留 Mantine 默认 5vw，手机 16px/安全区规则不变。
- 危险确认的 pending/禁用外观保留来源的实心错误色；新增按选择器、媒体作用域比较的主要控件声明与 token 回归，显式区分输入扩展、16px 下限等非一对一来源规则。
- 包描述覆盖安全区、主题与 Mantine 控件；删除指向 0.0.1 的旧 homepage，仓库目录与下述来源基线保持可追溯。
- 来源基线：Pi Reach `eb56e16c7ae47d0f131276dc32a706b58cb552a2`；来源路径为 `pwa/src/lib/ui/pi-reach-theme.ts`、`pwa/src/app/pwa-theme.css`、`pwa/src/app/globals.css`、`pwa/src/app/pwa-controls.css`。时长读取原理来自 `pwa/src/components/pwa/use-pwa-motion.ts` 和 `pwa/src/lib/ui/motion-duration.ts`；按钮绘制边界参考 `pwa/src/components/pwa/use-pwa-press-feedback.ts`。
- 未迁移触控补绘制 helper、业务行/outside tap、应用状态/存储、全局 provider、Portal/层级/遮罩互斥、焦点与 pending、Drawer 手势/转场、菜单/阅读器/Composer 等业务样式。原生 active 不保证所有触控微交互等价。
- 应用消费者的升级独立进行；发布此版本不代表应用已接入或完成生产验收。仅使用安全区的消费者可继续锁定 npm 0.0.1。

## 0.0.1

- 安全区 CSS 与浮层 shift 中间件。
