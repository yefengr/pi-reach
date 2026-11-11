/**
 * 常规按钮与文字按钮当前的高度（DESIGN「按钮尺寸」）：纯细指针为 36，存在粗指针或不可悬停时为 44。
 * 断言读取实际生效的 token 而不写死数值：Linux 无头 Chromium 关闭触控模拟后「存在粗指针」的状态不会复位，
 * 同一次运行里前面的文件开过触控模拟时，后面的文件会得到 44。
 */
export function buttonHeight(): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position: absolute; visibility: hidden; height: var(--pwa-button-height)";
  document.body.append(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return height;
}

/** 控件应有的最小高度：常规按钮与文字按钮取当前按钮高度，其余可点控件（图标按钮、行等）保持 44 点击区。 */
export function minimumControlHeight(control: Element): number {
  return control.classList.contains("pwa-button") ? buttonHeight() : 44;
}
