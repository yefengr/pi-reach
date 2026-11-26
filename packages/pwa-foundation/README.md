# @yefengr/pwa-foundation

PWA 基础包：安全区与最小点击区 CSS 变量、浮层 shift 中间件，以及从 0.0.2 起提供的可选主题与 Mantine 控件样式。

## 规范与消费契约

共享颜色、字体、间距、表面、动效、确认顺序与可访问性以 [公共设计与交互规范](DESIGN.md) 为唯一公共来源；本 README 只维护安装与接线契约。规范自 `0.0.3` 随包分发，旧版 `0.0.2` 不含 DESIGN.md，不回写该版本。

## 动效与触控辅助（0.0.4）

本节及下方表面能力自 `0.0.4` 提供，`0.0.3` 不包含它们。版本公开状态以 npm 为准，不得把本地制品冒充正式消费，也不能上传新候选覆盖旧版本。

- 根入口 `readPwaMotionDuration(token, fallback?, root?)`、`resolvePwaMotionDuration(style, token)`、`usePwaMotionDuration(token, fallback?, root?)` 读取时长；通用 fallback map 为 `PWA_MOTION_FALLBACK_MS`。宿主专属 token 显式传 fallback。支持毫秒、秒和有界 token 引用，非法值回退；hook 首次 SSR/水合采用普通回退，挂载后读 CSS 并响应系统减少动态效果，卸载清理监听。可选 root 使用其所属窗口。
- `pwaStandardEasing(element)`、`pwaContentEasing(element)`、`pwaMotionShiftDisabled(element)` 读取基础曲线与位移开关；不负责逐帧滚动、跟手或路由编排。
- `mantine` 入口增加 `pwaFadeTransition`、`pwaMenuTransition`、`pwaDrawerTransitions`（四向）、`PWA_DRAWER_EASE`、`usePwaMenuTransition()` 和 `usePwaDrawerTransition(position)`。后者返回可直接传给 Mantine `transitionProps` 的值；宿主仍负责 opened、Portal、关闭门禁和焦点。
- `installPressFeedback(scope, { buttonSelector, rowSelector?, shouldIgnore? })` 仅补该显式 scope 内的触控/笔按压绘制，不阻止原生点击或滚动。按钮即时反馈，行延迟 100ms；移动超过 10px、滚动、取消、失焦、隐藏、禁用或移除会清理，短触行补显 120ms，再用 press-out 淡出。卸载调用返回的释放函数。通用行外观显式添加 `pwa-press-row`；宿主可自行将标记映射到业务表面或伪元素。
- `installOutsideTapGuard(scope, { getTopFloating, isOwnTrigger })` 只保护宿主明确选定的无罩浮层，按下事件仍交给 Mantine 关闭；只取消同一次触摸外按随后产生的点按及焦点，不吞鼠标/键盘、浮层内部或自己的触发器。移动/滚动/取消/失焦/隐藏/新按下及卸载撤销。`outsideTapSwallowed(event)` 可用作按压辅助的 `shouldIgnore`。
- `readSystemBodySize(root?)`、`supportsSystemTextSize(root?)` 与 `textSizeForSystemBody(px)` 提供 WebKit 系统字号实测及三档映射（18/20px 分界，不能读取时标准档）。探针无论成功或异常均移除；它们不存储偏好、不注册应用跟踪，应用的身份、存储键、可见性恢复与设置入口仍由宿主维护。

上述安装器没有默认全页目标或业务选择器，须在客户端为自己拥有的根安装，生命周期结束释放。没有无罩浮层的应用不需要安装外点按保护；原生 select 不需要此辅助。

### 边框与表面

本节 API 自 `0.0.4` 提供。表面样式在 `theme.css` 后、宿主 CSS 前导入：

```tsx
import "@yefengr/pwa-foundation/surfaces.css";
import { installHairlineDetection } from "@yefengr/pwa-foundation";

// 在客户端启动时调用；React effect 可直接返回此释放函数。
const release = installHairlineDetection(document.documentElement);
// 宿主卸载或热更新清理时：
release();
```

根入口导出 `HAIRLINE_ATTRIBUTE`（`data-pwa-hairline`）、`detectHairline(root?: HTMLElement): boolean`、`installHairlineDetection(root?: HTMLElement): () => void`。省略 root 时使用当前 document 的根元素；SSR 检测返回 false、安装返回空释放函数，不在模块加载时读取 DOM。指定 root 时探针与监听使用其 ownerDocument/defaultView；标记可放在该根上，但包主题档位选择器针对 document 根元素。

`detectHairline` 是一次性实测并更新标记，不安装监听；只有实测高度大于 0 且小于 1 才启用半像素，隐藏、零高度或检测异常均回退常规档。安装会立即检测，随后在 resize 和分辨率变化时重测、重绑当前密度查询，不按 DPR 推断支持。相同 root 重复安装共享监听，各释放函数幂等，最后一份释放移除监听并恢复首次安装前的属性和值；安装期间显式 detect 改变标记也不改变这个恢复基准。

`theme.css` 新增 `card`、`separator-regular/hairline`、`edge-regular/hairline`、`hairline`、`separator`、`edge`、`shadow-panel`、`green/green-wash` 与 `amber/amber-wash`（均为 `--pwa-*` 变量）。最后两组只是颜色，不定义成功、运行等业务状态枚举；宿主自行映射。

可选 `surfaces.css` 只提供 `.pwa-ui-scope` 后代中的三个视觉角色：

- `pwa-surface-card`：card 底，无边框与阴影，16px 圆角；块级嵌入内容由宿主覆盖为 `var(--pwa-radius-lg)`（12px）。
- `pwa-surface-float`：surface 底，实测档位 edge 细框，float 阴影，12px 圆角。
- `pwa-surface-panel`：panel 底，实测档位 edge 细框，更轻的 panel 阴影（深色 none），16px 圆角。

这些不是业务组件，不自动添加到 Mantine Modal/Drawer，不改变已有控件的 1px 轮廓与 2px 焦点，也不接管 Portal、层级或生命周期。真实 Portal 使用这些角色时仍须位于 scope 内。

## 维护与发布

维护者可在 [PWA foundation npm 工作流](https://github.com/yefengr/pi-reach/actions/workflows/pwa-foundation-npm.yml)运行验证；手动运行的 `stage` 默认关闭，只检查类型、构建、测试并保存审核 tarball 与摘要，不上传 npm。也可在仓库中运行 `bash packages/pwa-foundation/publish-npm.sh`，本地临时包在退出时清理。

类型检查、安装、构建、测试与一次打包均在无 OIDC 权限的 `prepare` 作业执行。独立 `stage` 作业不安装依赖、不运行生命周期、不重新打包；它下载本次运行的制品，核对 prepare 输出的 SHA-256、版本、当前源码 SHA 与元数据后，才通过 GitHub OIDC 上传同一个 tarball。

新版本合入 `main` 且包版本变化时，工作流将审核 tarball 提交 npm 待审；手动勾选 `stage` 前应确认没有同版本待审。待审不是公开发布，需维护者在 npm 用 2FA 批准。已公开版本跳过，不重传；上传失败或结果不明时，先检查 npm 待审区，不直接重跑。

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

`0.0.2`／`0.0.3` 仅提供原生 `:active` 绘制。`0.0.4` 增加本页开头的显式触控安装器及普通 Drawer 转场；宿主需传入自己的作用域与目标，不提供自动侵入整页的 `usePwaButtonPressFeedback`。业务行表面映射、手势/导航、Portal 目标、层级、单层遮罩互斥、焦点返回、实例存活与 pending 门禁仍由宿主负责。

只使用安全区的现有消费者可继续锁定 npm 0.0.1。使用主题与控件时，显式安装 npm 精确版本（本版为 0.0.4）、所需 peer 和样式，接入 Provider/scope，并验证真实 Portal、键盘焦点、移动与桌面表现；本地制品验证不是正式升级，不要留下长期 file/workspace 依赖。
