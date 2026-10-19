import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { OperationFeedback } from "./operation-feedback";
import type { PendingSessionAction } from "@/lib/pwa/operation-feedback";

const compacting: PendingSessionAction = { id: "op", sessionId: "session", action: "session_compact", phase: "pending", startedAt: 0 };

/** 状态行不在 .pwa-composer 内，必须自行与输入卡片对齐到同一阅读列。 */
test.each([390, 1280])("operation status shares the composer column at %ipx", async width => {
  await page.viewport(width, 844);
  const screen = await renderPwa(<div className="pwa-chat-footer">
    <OperationFeedback pending={compacting} stop={null} compaction={null} />
    <form className="pwa-composer"><div className="pwa-composer-card" /></form>
  </div>);
  try {
    const status = document.querySelector<HTMLElement>(".pwa-operation-status")!;
    const card = document.querySelector<HTMLElement>(".pwa-composer-card")!;
    const composerStyle = getComputedStyle(document.querySelector<HTMLElement>(".pwa-composer")!);
    const statusStyle = getComputedStyle(status);
    expect(statusStyle.gap).toBe("6px");
    expect(statusStyle.paddingLeft).toBe(composerStyle.paddingLeft);
    expect(statusStyle.paddingRight).toBe(composerStyle.paddingRight);
    // 旋转中的 spinner 会改变自身包围盒，按行起点加内缩与卡片左缘比较。
    const contentLeft = status.getBoundingClientRect().left + parseFloat(statusStyle.paddingLeft);
    expect(Math.round(contentLeft)).toBe(Math.round(card.getBoundingClientRect().left));
  } finally {
    await screen.unmount();
  }
});
