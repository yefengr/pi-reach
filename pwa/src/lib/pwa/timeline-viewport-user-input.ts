/** 与历史前插的静止窗口一致；只暂停写入，不改变阅读意图。 */
const INPUT_IDLE_MS = 200;

/** 浏览器输入的来源与按住状态；不持有滚动器、计时器或阅读意图。 */
export class TimelineViewportUserInput {
  private until = -Infinity;
  held = false;
  interruptedMotion = false;

  engage(now: number, writing = false): void {
    if (!this.blocked(now)) this.interruptedMotion = false;
    this.interruptedMotion ||= writing;
    this.until = now + INPUT_IDLE_MS;
  }

  touch(active: boolean, now: number): void {
    this.held = active;
    this.until = now + INPUT_IDLE_MS;
  }

  blocked(now: number): boolean { return this.held || now < this.until; }

  reset(): void {
    this.until = -Infinity;
    this.held = false;
    this.interruptedMotion = false;
  }
}
