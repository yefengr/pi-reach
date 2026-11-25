# @yefengr/pwa-foundation

PWA 基础包：安全区与最小点击区 CSS 变量、浮层 shift 中间件，以及从 0.0.2 起提供的可选主题与 Mantine 控件样式。

## 规范与消费契约

共享颜色、字体、间距、表面、动效、确认顺序与可访问性以 [公共设计与交互规范](DESIGN.md) 为唯一公共来源；本 README 只维护安装与接线契约。规范自 `0.0.3` 随包分发，旧版 `0.0.2` 不含 DESIGN.md，不回写该版本。

## 维护与发布

维护者可在 [PWA foundation npm 工作流](https://github.com/yefengr/pi-reach/actions/workflows/pwa-foundation-npm.yml)运行验证；手动运行的 `stage` 默认关闭，只检查类型、构建、测试并保存审核 tarball 与摘要，不上传 npm。也可在仓库中运行 `bash packages/pwa-foundation/publish-npm.sh`，本地临时包在退出时清理。

新版本合入 `main` 且包版本变化时，工作流通过 GitHub OIDC 将同一个审核 tarball 提交 npm 待审；手动勾选 `stage` 前应确认没有同版本待审。待审不是公开发布，需维护者在 npm 用 2FA 批准。已公开版本跳过，不重传；上传失败或结果不明时，先检查 npm 待审区，不直接重跑。

发布基础包不会自动升级消费者。消费端仍需显式更新 npm 精确版本与锁文件，并完成各自的界面和交互验证；本地验证制品不能代替正式 npm 消费。

## 安全区 API 边界

- `useFloatingSafeMiddlewares` 只提供 `shift.padding`：对每侧取 5px 与安全区中的较大值。Popover、Menu 与 Combobox 可共用这组值；实际能否移动仍由浮层的定位、宽度和启用轴决定。例如 Mantine 上下定位且与锚点同宽时，默认关闭横向 shift。
- 浏览器与客户端的差异留在宿主应用内处理，本包不引入设备判断。

## React 用法

React 作为 peer dependency，需 `^19.2.4`。

```tsx
import { useFloatingSafeMiddlewares } from "@yefengr/pwa-foundation";

function Example() {
  const middlewares = useFloatingSafeMiddlewares();
  return <Popover middlewares={middlewares}>{/* ... */}</Popover>;
}
```

钩子在挂载后、窗口尺寸变化与屏幕方向变化时重新读取安全区；四边值未变化时保留原对象。它只更新中间件参数，不重建宿主浮层的定位实例；已打开浮层能否立即重新定位，需要在宿主组件中验证。

## CSS 用法

在应用样式入口导入一次：

```css
@import "@yefengr/pwa-foundation/foundation.css";
```

它只定义 `--pwa-safe-top`、`--pwa-safe-right`、`--pwa-safe-bottom`、`--pwa-safe-left`（取 `env(safe-area-inset-*, 0px)`）与 `--pwa-hit-target: 44px`，不包含颜色、字体与断点。

## 可选主题与控件（0.0.2）

旧根入口与 `foundation.css` 不变，根入口不静态依赖 Mantine 或 Lucide。
新增导出：`theme.css`、`controls.css` 和 `mantine`。
后者导出 `createPwaTheme(modalInDuration: number, modalOutDuration: number)`、`usePwaTheme()`、`pwaCssVariablesResolver`、`pwaModalTransition`、`PWA_DIALOG_SIZE`（480）、`PWA_CONFIRM_DIALOG_SIZE`（400）。时长单位为毫秒。

仅验证过 React 19.2.4、Mantine core/hooks 9.5.2、lucide-react 1.33.0。三个新 peer 均为 optional，使用 Mantine 入口时必须自行安装这些精确版本；仅使用安全区能力不需要安装。宿主使用 Mantine 所需的 react-dom。

样式按以下顺序导入，宿主业务 CSS 最后导入：

```tsx
import "@mantine/core/styles.css";
import "@yefengr/pwa-foundation/foundation.css";
import "@yefengr/pwa-foundation/theme.css";
import "@yefengr/pwa-foundation/controls.css";
import { MantineProvider, Button, Modal } from "@mantine/core";
import { LucideProvider } from "lucide-react";
import { useMediaQuery } from "@mantine/hooks";
import { usePwaTheme, pwaCssVariablesResolver, PWA_CONFIRM_DIALOG_SIZE } from "@yefengr/pwa-foundation/mantine";

// useMediaQuery 来自 @mantine/hooks；以布局宽度判断，不以指针类型判断。
function Ui({ opened, onClose, onConfirm }) {
  const theme = usePwaTheme();
  const mobile = useMediaQuery("(max-width: 767.98px)", undefined, { getInitialValueInEffect: false });
  const confirm = <Button key="confirm" onClick={onConfirm}>确认</Button>;
  const cancel = <Button key="cancel" variant="default" onClick={onClose}>取消</Button>;
  return <LucideProvider strokeWidth={1.5} absoluteStrokeWidth>
    <MantineProvider theme={theme} cssVariablesResolver={pwaCssVariablesResolver}>
      <div className="pwa-ui-scope">
        <div id="overlay-root" />
        <Modal opened={opened} onClose={onClose} title="确认操作" size={PWA_CONFIRM_DIALOG_SIZE}
          portalProps={{ target: "#overlay-root" }}>
          <p className="pwa-confirm-description">请确认后继续。</p>
          <div className="pwa-confirm-actions">
            {mobile ? [confirm, cancel] : [cancel, confirm]}
          </div>
        </Modal>
      </div>
    </MantineProvider>
  </LucideProvider>;
}
```

LucideProvider 使用实际线宽 1.5px（`absoluteStrokeWidth`）；按钮文字旁 `size={16}` 的行内图标跟随字号并使用 2px 实际线宽，独立图标按钮用 `size={20}`。主题关闭按钮自动使用 Lucide X。

`theme.css` 在根元素提供明暗语义 token、系统字体、间距与三档字号；未指定 Mantine 主题属性时按系统暗色回退。字号通过根元素 `data-pwa-text-size="large"`／`"xlarge"` 选择，移除属性恢复标准档；选择逻辑与持久化由宿主负责。没有 body reset、应用高度或层级默认值。

`controls.css` 仅作用于 `.pwa-ui-scope` 后代；Portal 节点也必须位于该作用域内。主题自动分配 Button 的 `pwa-button`、ActionIcon/关闭按钮的 `pwa-icon-button`、TextInput 的 `pwa-input`、Textarea 的 `pwa-textarea`、Select/NativeSelect 的 `pwa-select`，以及 Modal 的 `pwa-dialog`／`pwa-dialog-head`／`pwa-dialog-title`／`pwa-dialog-body`、Drawer 的 `pwa-drawer`／`pwa-drawer-head`／`pwa-drawer-title`。Modal 遮罩通过主题 `classNames.overlay` 自动使用 `pwa-scrim`，传入 `overlayProps`（如 `blur: 0`）不会丢失该默认类；宿主仍可明确覆盖样式。桌面外侧留白沿用 Mantine 默认值（5vw），24px 是内容内边距；手机外侧留白为 16px 与左右安全区的较大值。

宿主显式使用的辅助类为 `pwa-confirm-description`、`pwa-confirm-error`、`pwa-confirm-actions`、`pwa-danger-confirm`。`pwa-confirm-actions` 不排序节点：宿主根据布局生成桌面「取消、确认」、手机「确认、取消」的真实 DOM；排法与变体见 [控件与确认操作](DESIGN.md#控件与确认操作)。危险确认的 pending/禁用外观仍为实心错误色，宿主不能因此省略操作门禁。

此处修正 `0.0.2` README 将「确认在前」写成全尺寸要求的错误；既有规则的手机限定不能省略。按旧描述实现桌面的消费者需按上例调整 JSX 顺序，无需 CSS 反转或新组件。此修正随 `0.0.3` 文档分发，不回写公开 `0.0.2`。

上例只演示消费结构。真实宿主保留 Modal 实例，让 `opened` 从 true 变 false，退出后再清理快照；同时接入有效回焦后备、同步 pending 门禁与错误保留，见 [关闭、焦点与异步操作](DESIGN.md#关闭焦点与异步操作)。不要在 `onClose` 中直接条件卸载整个 Modal。

`usePwaTheme` 挂载后读取 CSS Modal 进入/退出时长并监听系统减少动态效果变化，SSR/首次水合回退 400/200ms；样式缺失且系统要求减少动态效果时回退 120ms。非浏览器消费者可直接调用工厂。本批不迁移完整动效框架。

只迁移原生 `:active` 按钮绘制与 reduced-motion CSS，不提供 `usePwaButtonPressFeedback`；部分触控浏览器不保持 `:active` 时不保证与 Pi Reach 的触控补绘制相同。业务行按下、outside-tap guard、Drawer 转场/手势/导航、Portal 目标、层级、单层遮罩互斥、焦点返回、实例存活与 pending 门禁仍由宿主负责。

只使用安全区的现有消费者可继续锁定 npm 0.0.1。使用主题与控件时，显式安装 npm 精确版本（本版为 0.0.3）、所需 peer 和样式，接入 Provider/scope，并验证真实 Portal、键盘焦点、移动与桌面表现；本地制品验证不是正式升级，不要留下长期 file/workspace 依赖。
