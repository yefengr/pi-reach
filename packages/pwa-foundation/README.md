# @yefengr/pwa-foundation

PWA 的安全区基础包：安全区与最小点击区 CSS 变量，以及浮层 shift 中间件。

## 公共规则

- 安全区只由实际贴住该屏幕边缘的布局层使用，同一边只计算一次；贴边层的背景延伸进安全区、内容内缩，子层不再叠加。
- 不贴边的居中叠层与屏幕边缘的距离取基础留白与安全区中的较大值，不相加。
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
