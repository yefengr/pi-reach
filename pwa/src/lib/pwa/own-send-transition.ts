import { FollowMotionClock } from "./timeline-follow-motion";

type InputSize = { height: number; maximum: number; overflow: string };
const inputOwners = new WeakMap<HTMLTextAreaElement, OwnSendTransition>();

/** Autosize 仍负责测量；仅成功发送期间由时间线的同一个帧循环写入高度。 */
export function stageOwnSendInputSize(input: HTMLTextAreaElement, size: InputSize): boolean {
  const owner = inputOwners.get(input);
  if (!owner) return false;
  owner.inputSize = size;
  return true;
}

/** 预算读取自然内容，不把正在收回的附件空槽当作新的固定 chrome。 */
export function ownSendFooterChrome(input: HTMLTextAreaElement): number | null {
  return inputOwners.get(input)?.naturalChrome ?? null;
}

/** 不持有 RAF；生命周期、用户中断与滚动写入全部属于 useTimelineViewport。 */
export class OwnSendTransition {
  readonly list: HTMLDivElement;
  inputSize: InputSize | null = null;
  private readonly input: HTMLTextAreaElement | null;
  private readonly footer: HTMLElement | null;
  private readonly composer: HTMLElement | null;
  private readonly footerStyle: string;
  private readonly inputHeight: number;
  private readonly footerHeight: number;
  private scrollTop: number;
  private paddingTop: number;
  private readonly clock: FollowMotionClock;

  constructor(list: HTMLDivElement) {
    this.list = list;
    const main = list.closest(".pwa-main");
    this.input = main?.querySelector<HTMLTextAreaElement>(".pwa-composer-input") ?? null;
    this.footer = main?.querySelector<HTMLElement>(".pwa-chat-footer") ?? null;
    this.composer = this.footer?.querySelector<HTMLElement>(".pwa-composer") ?? null;
    this.scrollTop = list.scrollTop;
    this.inputHeight = this.input?.getBoundingClientRect().height ?? 0;
    this.footerHeight = this.footer?.getBoundingClientRect().height ?? 0;
    this.footerStyle = this.footer?.style.height ?? "";
    if (this.input) inputOwners.set(this.input, this);
    if (this.footer && this.composer) {
      // 附件提交会移除卡片，短期保留真实 footer 尺寸并贴底收回；不留下固定占位。
      this.footer.style.height = `${this.footerHeight}px`;
    }
    const style = getComputedStyle(list);
    this.paddingTop = Number.parseFloat(style.paddingTop) || 0;
    this.clock = new FollowMotionClock(list);
  }

  get naturalChrome(): number | null {
    if (!this.composer || !this.input) return null;
    return this.composer.getBoundingClientRect().height - this.input.getBoundingClientRect().height;
  }

  /** 返回当前帧的滚动目标；后续布局只更新目标，时钟不会重启。 */
  advance(now: number): { top: number; finished: boolean } {
    const { progress, fraction, finished } = this.clock.sample(now);
    const size = this.inputSize;
    if (this.input && size) {
      this.input.style.maxHeight = `${Math.max(this.inputHeight, size.maximum)}px`;
      this.input.style.height = `${this.inputHeight + (size.height - this.inputHeight) * progress}px`;
      this.input.style.overflowY = size.overflow;
    }
    let remainingShrink = 0;
    if (this.footer && this.composer) {
      const actualInput = this.input?.getBoundingClientRect().height ?? 0;
      const target = this.composer.getBoundingClientRect().height + (size ? size.height - actualInput : 0);
      const height = this.footerHeight + (target - this.footerHeight) * progress;
      this.footer.style.height = `${height}px`;
      remainingShrink = target - this.footer.getBoundingClientRect().height;
    }
    const bottom = Math.max(0, this.list.scrollHeight - this.list.clientHeight + remainingShrink);
    // 真实预算切换可能改变顶部 padding；先补偿锚点，不让密度切换在第一帧移动旧正文。
    const padding = Number.parseFloat(getComputedStyle(this.list).paddingTop) || 0;
    this.scrollTop += padding - this.paddingTop;
    this.paddingTop = padding;
    this.scrollTop += (bottom - this.scrollTop) * fraction;
    return { top: this.scrollTop, finished };
  }

  /** 清理绑定及临时尺寸，取消后迟到帧不再拥有这些元素。 */
  finish(settleInput = true): void {
    this.clock.cancel();
    if (this.input && inputOwners.get(this.input) === this) {
      inputOwners.delete(this.input);
      if (settleInput && this.inputSize) Object.assign(this.input.style, {
        height: `${this.inputSize.height}px`, maxHeight: `${this.inputSize.maximum}px`, overflowY: this.inputSize.overflow,
      });
    }
    if (this.footer) this.footer.style.height = this.footerStyle;
  }
}
