/** 输入区浮在消息列表之上（ADR-20261105）：列表底部留白须同步输入区的实际高度。 */
export const CHAT_FOOTER_SELECTOR = ".pwa-chat-footer";
export const CHAT_FOOTER_SPACE_PROPERTY = "--pwa-chat-footer-space";

/** 输入区与消息列表同属一个工作区列，是列表的兄弟节点。 */
export function chatFooterOf(list: HTMLElement): HTMLElement | null {
  return list.parentElement?.querySelector<HTMLElement>(`:scope > ${CHAT_FOOTER_SELECTOR}`) ?? null;
}

/** 已写入列表的输入区高度；测量自然尾部留白时须扣除，它被输入区盖住，不能用来容纳内容增长。 */
export function chatFooterSpace(list: HTMLElement): number {
  return Number.parseFloat(list.style.getPropertyValue(CHAT_FOOTER_SPACE_PROPERTY)) || 0;
}

/**
 * 按输入区当前高度同步列表底部留白，返回同步后的值。
 * 写入发生在读取滚动几何之前：发送过渡逐帧改变输入区高度时，同一帧内的 scrollHeight 已包含新留白。
 */
export function syncChatFooterSpace(list: HTMLElement, footer: HTMLElement | null = chatFooterOf(list)): number {
  const height = footer && footer.isConnected ? footer.getBoundingClientRect().height : 0;
  if (Math.abs(height - chatFooterSpace(list)) > 0.01 || !list.style.getPropertyValue(CHAT_FOOTER_SPACE_PROPERTY)) {
    list.style.setProperty(CHAT_FOOTER_SPACE_PROPERTY, `${height}px`);
  }
  return height;
}
