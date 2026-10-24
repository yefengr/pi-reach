import { TIMELINE_GEOMETRY_EVENT } from "./timeline-viewport-observers";

// 仅用于页面过渡收尾，不判断系统键盘是否退场。
const MOTION_SETTLE_MS = 32;
// 预支意图或重定向均至少保留半段可见过渡，不能让旧预算耗尽后瞬跳。
const MIN_VISIBLE_FRACTION = 0.5;

/** 只拥有收起尺寸与留白交接，不拥有恢复判定、输入预算或滚动位置。 */
export class KeyboardClosingMotion {
  private frame = 0;
  private timer = 0;
  private intentFrame = 0;
  private intentAt: number | null = null;
  private deadline = 0;
  private height = 0;
  private restoreSafeArea = false;

  constructor(private readonly shell: HTMLElement, private readonly density: () => void,
    private readonly onEnd: () => void, private readonly preparePadding: (height: number) => void) {}
  get active() { return this.frame !== 0 || this.timer !== 0; }
  get target() { return this.active ? this.height : null; }

  intend() {
    if (this.active || this.intentFrame || this.intentAt !== null) return;
    // 不在发送所在任务记账；长任务不能提前消费还没机会绘制的过渡。
    this.intentFrame = requestAnimationFrame(() => { this.intentFrame = 0; this.intentAt = performance.now(); });
  }

  move(height: number, restoreSafeArea: boolean): boolean {
    if (this.active && height === this.height && restoreSafeArea === this.restoreSafeArea) return true;
    const value = getComputedStyle(this.shell).getPropertyValue("--pwa-duration-keyboard").trim();
    const number = Number.parseFloat(value);
    const duration = Number.isFinite(number) ? number * (value.endsWith("ms") ? 1 : 1000) : 0;
    if (!(duration > 0)) { this.stop(); return false; }
    this.height = height;
    this.restoreSafeArea = restoreSafeArea;
    if (this.timer) {
      this.commit(Math.max(duration * MIN_VISIBLE_FRACTION, this.deadline - performance.now()));
    } else if (!this.frame) {
      const age = this.intentAt === null ? 0 : performance.now() - this.intentAt;
      // 过期意图丢弃；在真实增长事件冻结预支，不把后续任务到首帧的阻塞算入耗时。
      const credit = age < duration ? Math.min(age, duration * (1 - MIN_VISIBLE_FRACTION)) : 0;
      this.clearIntent();
      this.frame = requestAnimationFrame(() => { this.frame = 0; this.commit(duration - credit); });
    }
    return true;
  }

  private commit(duration: number) {
    void getComputedStyle(this.shell).height;
    this.deadline = performance.now() + duration;
    this.shell.style.setProperty("--pwa-keyboard-motion-duration", `${duration}ms`);
    this.shell.style.setProperty("--pwa-keyboard-layout-duration", `${duration}ms`);
    this.shell.dataset.keyboardClosing = "";
    this.preparePadding(this.height);
    this.shell.toggleAttribute("data-keyboard-restored", this.restoreSafeArea);
    this.shell.style.setProperty("--pwa-viewport-height", `${this.height}px`);
    void getComputedStyle(this.shell).height;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.sample();
      this.stop();
      this.onEnd();
    }, duration + MOTION_SETTLE_MS);
    if (!this.frame) this.frame = requestAnimationFrame(() => this.tick());
  }

  private sample() {
    this.shell.style.setProperty("--pwa-keyboard-layout-duration", `${Math.max(0, this.deadline - performance.now())}ms`);
    this.density();
    // padding变化不一定触发列表ResizeObserver；复用时间线的唯一锚点/贴底所有者。
    this.shell.querySelector(".pwa-message-list")?.dispatchEvent(new Event(TIMELINE_GEOMETRY_EVENT));
  }

  private tick() {
    this.frame = 0;
    this.sample();
    if (this.timer) this.frame = requestAnimationFrame(() => this.tick());
  }

  private clearIntent() {
    cancelAnimationFrame(this.intentFrame);
    this.intentFrame = 0;
    this.intentAt = null;
  }

  stop() {
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.timer);
    this.clearIntent();
    this.frame = this.timer = 0;
    this.deadline = 0;
    delete this.shell.dataset.keyboardClosing;
    delete this.shell.dataset.keyboardNormalPadding;
    this.shell.style.removeProperty("--pwa-keyboard-motion-duration");
    this.shell.style.removeProperty("--pwa-keyboard-layout-duration");
    // 安全区由控制器与最终高度一起交接，不能先撤掉再测量而钳制scrollTop。
  }
}
