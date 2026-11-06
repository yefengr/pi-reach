import { MOBILE_LAYOUT_QUERY, TOUCH_INPUT_QUERY } from "@/lib/ui/viewport-queries";

const OWN_SEND_ATTRIBUTE = "data-own-send";
const noop = () => {};

/**
 * 触屏移动布局下发送成功后收起软键盘：等本端发送过渡结束（footer 移除 data-own-send）再让输入框失焦，
 * 键盘下落与整页复位不与气泡进入、输入区回缩叠在同一时刻（DESIGN「编排」）。
 * 没有发送过渡（如附件先上传、回看中发送）时立即收起。等待期间焦点已离开或用户已开始输入下一条时保持现状。
 * 返回取消函数，组件卸载时停止等待。
 */
export function dismissKeyboardAfterSend(input: HTMLTextAreaElement | null): () => void {
  if (!input || document.activeElement !== input) return noop;
  if (!window.matchMedia(MOBILE_LAYOUT_QUERY).matches || !window.matchMedia(TOUCH_INPUT_QUERY).matches) return noop;
  const dismiss = () => {
    if (document.activeElement === input && input.value === "") input.blur();
  };
  const footer = input.closest<HTMLElement>(".pwa-chat-footer");
  if (!footer?.hasAttribute(OWN_SEND_ATTRIBUTE)) {
    // 清空草稿的渲染尚未提交，下一帧再判断：发送失败而草稿保留时不收起。
    const frame = requestAnimationFrame(dismiss);
    return () => cancelAnimationFrame(frame);
  }
  const observer = new MutationObserver(() => {
    if (footer.hasAttribute(OWN_SEND_ATTRIBUTE)) return;
    observer.disconnect();
    dismiss();
  });
  observer.observe(footer, { attributes: true, attributeFilter: [OWN_SEND_ATTRIBUTE] });
  return () => observer.disconnect();
}
