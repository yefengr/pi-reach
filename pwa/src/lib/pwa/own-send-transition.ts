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

export type OwnSendLayoutCapture = Readonly<{
  list: HTMLDivElement;
  input: HTMLTextAreaElement | null;
  footer: HTMLElement | null;
  composer: HTMLElement | null;
  top: number;
  inputHeight: number;
  footerHeight: number;
  footerStyle: string;
  paddingTop: number;
}>;

/** 最终提交前只读捕获；不注册 owner，不修改尺寸或阅读意图。 */
export function captureOwnSendLayout(list: HTMLDivElement): OwnSendLayoutCapture {
  const main = list.closest(".pwa-main");
  const input = main?.querySelector<HTMLTextAreaElement>(".pwa-composer-input") ?? null;
  const footer = main?.querySelector<HTMLElement>(".pwa-chat-footer") ?? null;
  return Object.freeze({
    list, input, footer, composer: footer?.querySelector<HTMLElement>(".pwa-composer") ?? null,
    top: list.scrollTop, inputHeight: input?.getBoundingClientRect().height ?? 0,
    footerHeight: footer?.getBoundingClientRect().height ?? 0,
    footerStyle: (input ? inputOwners.get(input)?.naturalFooterStyle : undefined) ?? footer?.style.height ?? "",
    paddingTop: Number.parseFloat(getComputedStyle(list).paddingTop) || 0,
  });
}

/** 不持有 RAF；生命周期、用户中断与滚动写入全部属于协调器。 */
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

  constructor(capture: OwnSendLayoutCapture) {
    this.list = capture.list;
    this.input = capture.input;
    this.footer = capture.footer;
    this.composer = capture.composer;
    this.scrollTop = capture.top;
    this.inputHeight = capture.inputHeight;
    this.footerHeight = capture.footerHeight;
    this.footerStyle = capture.footerStyle;
    if (this.input) {
      // 成功回调可能晚于 autosize 的布局提交，先保存已提交的自然终点，再恢复预捕获的起点。
      this.inputSize = {
        height: Number.parseFloat(this.input.style.height) || this.input.getBoundingClientRect().height,
        maximum: Number.parseFloat(this.input.style.maxHeight) || this.inputHeight,
        overflow: this.input.style.overflowY,
      };
      inputOwners.set(this.input, this);
      this.input.style.maxHeight = `${Math.max(this.inputHeight, this.inputSize.maximum)}px`;
      this.input.style.height = `${this.inputHeight}px`;
    }
    if (this.footer && this.composer) {
      // 附件提交会移除卡片，短期保留真实 footer 尺寸并贴底收回；不留下固定占位。
      this.footer.style.height = `${this.footerHeight}px`;
    }
    this.paddingTop = capture.paddingTop;
    this.clock = new FollowMotionClock(this.list);
  }

  get naturalFooterStyle(): string { return this.footerStyle; }

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
