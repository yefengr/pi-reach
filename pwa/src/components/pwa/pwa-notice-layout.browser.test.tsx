import { useRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PwaUiProvider } from "./pwa-ui-provider";
import { MessageComposer } from "./message-composer";
import { PwaAppShell, PwaRuntimeNoticeSlot } from "./pwa-app-shell";
import { PwaStatusError } from "./pwa-app-actions";
import { ServiceWorkerNotice } from "./service-worker-register";
import { WorkspaceTitleBar } from "./workspace-title-bar";
import { useMainNoticesSpace } from "./use-main-notices-space";

function NoticeLayoutHarness({ onSend, initialDraft }: { onSend: () => void; initialDraft: string }) {
  const [draft, setDraft] = useState(initialDraft);
  const [error, setError] = useState<string | null>("The saved conversation could not be updated. Reconnect and try again.");
  const [notice, setNotice] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const noticesRef = useRef<HTMLDivElement>(null);
  useMainNoticesSpace(rootRef, noticesRef);
  return <PwaAppShell runtimeNotice={notice && <ServiceWorkerNotice onDismiss={() => setNotice(false)} />}>
    <div ref={rootRef} className="pwa-root">
      <div className="pwa-layout"><div className="pwa-desktop-navigation"><aside className="pwa-sidebar">
        <div className="pwa-navigation-scroll">Sessions</div>
        <PwaRuntimeNoticeSlot className="pwa-navigation-notice-slot" />
        <div className="pwa-sidebar-foot"><button type="button">office</button></div>
      </aside></div><main className="pwa-main">
        <WorkspaceTitleBar title="Pi Reach" prefix="pi-reach" showTitle navigationExpanded={false} onOpenNavigation={() => {}} onRefresh={() => {}} />
        <div ref={noticesRef} className="pwa-main-notices">
          <PwaStatusError message={error} onDismiss={() => setError(null)} />
        </div>
        <div className="pwa-message-list">Current session output</div>
        <div className="pwa-chat-footer"><MessageComposer
          connectionHint={{ text: "Can't reach Relay. Retrying automatically…", tone: "neutral", busy: true, action: { label: "Retry now", onAction: () => {} } }}
          attachments={[]} canAttach={false} sendingAttachments={false} isOnline isWorking={false} stopping={false}
          draft={draft} onDraftChange={setDraft} onSend={onSend} onStop={() => {}}
          onAddFiles={() => {}} onRemoveAttachment={() => {}} onRetryAttachment={() => {}}
          commandModels={[]} commandCurrentModel={null} commandCurrentModelFallback={null} commandThinking="off" commandPendingAction={null}
          onNewSession={() => {}} onCompactSession={() => {}} onSetModel={() => {}} onSetThinking={() => {}} onCommandsOpen={() => {}}
        /></div>
      </main></div>
    </div>
  </PwaAppShell>;
}

afterEach(async () => { vi.unstubAllGlobals(); await page.viewport(1280, 900); });

// 软键盘交给浏览器：只有布局视口真实缩小（resizes-content、横屏、矮窗口）时，应用才需容纳在更矮的高度内。
const viewports = [
  { width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 390, height: 500 },
  { width: 756, height: 413 }, { width: 844, height: 390 }, { width: 768, height: 440 },
];

test.each(viewports.flatMap((viewport) => [3, 10].map((lines) => ({ ...viewport, lines }))))("keeps a $lines-line draft clickable with all notices at $width × $height", async ({ width, height, lines }) => {
  await page.viewport(width, height);
  const onSend = vi.fn();
  const screen = await render(<PwaUiProvider><NoticeLayoutHarness onSend={onSend} initialDraft={"A draft line\n".repeat(lines).trim()} /></PwaUiProvider>);
  // Toast 是标题区下方的浮层，另见 pwa-operation-notifications 测试。
  expect(document.querySelectorAll(".pwa-root")).toHaveLength(1);
  const desktop = width >= 768;
  // 运行时提示位于导航底部（ADR-20261105）：移动布局不显示侧栏，提示随之不可见，打开移动导航后才出现。
  if (desktop) await expect.element(screen.getByRole("status", { name: "Offline app mode unavailable" })).toBeVisible();
  else await expect.poll(() => document.querySelector(".pwa-runtime-notice")).not.toBeNull();
  // Portal 挂载通知后，再等布局观察器完成输入区预算与阅读区同步。
  for (let frame = 0; frame < 6; frame += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const runtimeNotice = document.querySelector<HTMLElement>(".pwa-runtime-notice")!;
  const slot = document.querySelector<HTMLElement>(".pwa-navigation-notice-slot")!;
  expect(runtimeNotice.parentElement).toBe(slot);
  expect(document.querySelector(".pwa-runtime-notice-fallback")!.getBoundingClientRect().height).toBe(0);
  // 正式标题区：桌面上方 12 加两行最小 64，移动端单行 48；矮密度只由外壳实际高度决定。
  const titleBar = document.querySelector<HTMLElement>(".pwa-title-bar")!;
  expect(Math.round(titleBar.getBoundingClientRect().height)).toBe(width >= 768 ? 76 : 48);
  // 导航底部的提示不占消息区高度，矮窗口也不压缩；局部错误浮在标题区下方，不推动列表。
  const runtimeStyle = getComputedStyle(runtimeNotice);
  expect([runtimeStyle.marginTop, runtimeStyle.paddingTop, runtimeStyle.paddingBottom]).toEqual(["8px", "10px", "10px"]);
  const errorBox = document.querySelector<HTMLElement>(".pwa-status-error")!.getBoundingClientRect();
  const titleBottom = titleBar.getBoundingClientRect().bottom;
  expect(Math.round(document.querySelector(".pwa-message-list")!.getBoundingClientRect().top)).toBe(Math.round(titleBottom));
  expect(Math.round(errorBox.top - titleBottom)).toBe(8);
  const composer = document.querySelector(".pwa-composer-card")!;
  const input = screen.getByPlaceholder("Message your agent…");
  const send = screen.getByRole("button", { name: "Send message", exact: true });
  for (const target of [input.element(), send.element()]) {
    const box = target.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(height);
    expect(target.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))).toBe(true);
  }
  const composerBox = composer.getBoundingClientRect();
  // 连接问题已移入输入框提示行（ADR-20261105）；重试仍须完整可点。
  expect(document.querySelector(".pwa-composer-hint-action")).not.toBeNull();
  const retry = screen.getByRole("button", { name: "Retry now" }).element();
  const retryBox = retry.getBoundingClientRect();
  expect(retryBox.height).toBeGreaterThanOrEqual(44);
  expect(retryBox.width).toBeGreaterThanOrEqual(44);
  expect(retry.contains(document.elementFromPoint(retryBox.x + retryBox.width / 2, retryBox.y + retryBox.height / 2))).toBe(true);
  const runtimeBox = runtimeNotice.getBoundingClientRect();
  const sidebarBox = document.querySelector(".pwa-sidebar")!.getBoundingClientRect();
  if (desktop) {
    expect(runtimeBox.left).toBeGreaterThanOrEqual(sidebarBox.left);
    expect(runtimeBox.right).toBeLessThanOrEqual(sidebarBox.right);
    expect(runtimeBox.bottom).toBeLessThanOrEqual(document.querySelector(".pwa-sidebar-foot")!.getBoundingClientRect().top);
  }
  for (const name of desktop ? ["Dismiss PWA notice"] : []) {
    const button = screen.getByRole("button", { name, exact: true }).element();
    const box = button.getBoundingClientRect();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.left).toBeGreaterThanOrEqual(runtimeBox.left);
    expect(box.right).toBeLessThanOrEqual(runtimeBox.right);
    expect(box.bottom).toBeLessThanOrEqual(runtimeBox.bottom);
    expect(button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))).toBe(true);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
  const listBox = list.getBoundingClientRect();
  // 消息列表必须容得下正文一行加上下各 8px 内边距；当前 token 下 floor 为 ceil(26.4 + 16) = 43。
  const listStyle = getComputedStyle(list);
  const bodyLine = parseFloat(listStyle.getPropertyValue("--pwa-text-body")) * parseFloat(listStyle.getPropertyValue("--pwa-leading-body"));
  const readingFloor = Math.ceil(bodyLine + 8 * 2);
  expect(readingFloor).toBe(43);
  expect(Math.round(listBox.height)).toBeGreaterThanOrEqual(readingFloor);
  expect(document.querySelector("[data-composer-budget='conflict']")).toBeNull();
  const contentRange = document.createRange();
  contentRange.selectNodeContents(list);
  const contentBox = contentRange.getBoundingClientRect();
  expect(contentBox.bottom).toBeLessThanOrEqual(listBox.bottom);
  expect(list.contains(document.elementFromPoint(contentBox.x + contentBox.width / 2, contentBox.y + contentBox.height / 2))).toBe(true);
  for (const notice of document.querySelectorAll(".pwa-status-error")) {
    const box = notice.getBoundingClientRect();
    expect(box.bottom <= composerBox.top || box.top >= composerBox.bottom, JSON.stringify({ notice: notice.className, noticeBox: box.toJSON(), composerBox: composerBox.toJSON() })).toBe(true);
  }
  await input.click();
  await expect.element(input).toHaveFocus();
  if (lines === 10) {
    expect(input.element().scrollHeight).toBeGreaterThan(input.element().clientHeight);
    expect(getComputedStyle(input.element()).overflowY).toMatch(/auto|scroll/);
  }
  if (lines === 10) await page.screenshot({ path: `../../../.vitest/screenshots/brand-gap-notices-${width}x${height}.png` });
  await send.click();
  expect(onSend).toHaveBeenCalledOnce();
  await screen.getByRole("button", { name: "Dismiss", exact: true }).click();
  input.element().focus();
  if (desktop) {
    const dismissRuntime = screen.getByRole("button", { name: "Dismiss PWA notice", exact: true });
    dismissRuntime.element().focus();
    await dismissRuntime.click();
    await expect.element(input).toHaveFocus();
    expect(slot.getBoundingClientRect().height).toBe(0);
  }
  await expect.element(input).toHaveValue("A draft line\n".repeat(lines).trim());
  await send.click();
  expect(onSend).toHaveBeenCalledTimes(2);
  await screen.unmount();
});
