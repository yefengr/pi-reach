import { ScrollIdleGate, type ScrollIdleClock } from "./scroll-idle-gate";

/**
 * 「最新」入口的显示时机，与是否跟随分开判断：跟随在离底部 32px 内即恢复，入口要离底部超过一屏才有意义，
 * 否则往上看一两行、惯性或回弹都会让它反复出现。离开超过一屏时，等触摸、惯性与回弹结束后才显示；
 * 回到一屏以内立即隐藏，不等滚动停下。未读输出与是否跟随由调用方另行合并。
 */
export class LatestEntryVisibility {
  private readonly gate: ScrollIdleGate;
  private visible = false;
  private cancel: (() => void) | null = null;

  constructor(clock: ScrollIdleClock, private readonly changed: (visible: boolean) => void) {
    this.gate = new ScrollIdleGate(clock);
  }

  touch(active: boolean): void {
    this.gate.touch(active);
  }

  /** 每次 scroll 报告离底部的距离与视口高度。 */
  scrolled(distance: number, viewport: number): void {
    this.gate.scrolled();
    if (distance <= viewport) { this.hide(); return; }
    // 已显示时继续滚动不闪烁；等待中再次滚动由门禁按最新时间重新计时。
    if (this.visible || this.cancel) return;
    this.cancel = this.gate.defer(() => {
      this.cancel = null;
      this.set(true);
    });
  }

  hide(): void {
    this.cancel?.();
    this.cancel = null;
    this.set(false);
  }

  dispose(): void {
    this.cancel = null;
    this.gate.dispose();
  }

  private set(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.changed(visible);
  }
}
