import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PwaUiProvider } from "./pwa-ui-provider";
import { MessageComposer } from "./message-composer";
import { PwaAppShell, PwaRuntimeNoticeSlot } from "./pwa-app-shell";
import { PwaConnectionBanner, PwaStatusToast } from "./pwa-app-actions";
import { ServiceWorkerNotice } from "./service-worker-register";

function NoticeLayoutHarness({ onSend, initialDraft }: { onSend: () => void; initialDraft: string }) {
  const [draft, setDraft] = useState(initialDraft);
  const [error, setError] = useState<string | null>("The saved conversation could not be updated. Reconnect and try again.");
  const [notice, setNotice] = useState(true);
  return <PwaAppShell runtimeNotice={notice && <ServiceWorkerNotice installPrompt unsupported={false} onInstall={() => {}} onDismiss={() => setNotice(false)} />}>
    <div className="pwa-root">
      <div className="pwa-layout"><div className="pwa-desktop-navigation"><aside className="pwa-sidebar">Sessions</aside></div><main className="pwa-main">
        <header className="pwa-title-bar">Pi Reach</header>
        <div className="pwa-main-notices">
          <PwaConnectionBanner kind="relay" connection="retrying" onRetry={() => {}} />
          <PwaStatusToast message={error} onDismiss={() => setError(null)} />
          <PwaRuntimeNoticeSlot />
        </div>
        <div className="pwa-message-list">Current session output</div>
        <div className="pwa-chat-footer"><MessageComposer
          attachment={null} canAttachImage={false} sendingImage={false} isOnline isWorking={false} stopping={false}
          draft={draft} onDraftChange={setDraft} onSend={onSend} onStop={() => {}}
          onSetAttachment={() => {}} onClearAttachment={() => {}}
          commandModels={[]} commandCurrentModel={null} commandCurrentModelFallback={null} commandThinking="off" commandPendingAction={null}
          onNewSession={() => {}} onCompactSession={() => {}} onSetModel={() => {}} onSetThinking={() => {}} onCommandsOpen={() => {}}
        /></div>
      </main></div>
    </div>
  </PwaAppShell>;
}

afterEach(async () => { vi.unstubAllGlobals(); await page.viewport(1280, 900); });

const viewports = [
  { width: 1440, height: 900, visibleHeight: 900 }, { width: 390, height: 844, visibleHeight: 844 },
  { width: 390, height: 500, visibleHeight: 500 }, { width: 756, height: 413, visibleHeight: 413 },
  { width: 390, height: 844, visibleHeight: 500 }, { width: 844, height: 844, visibleHeight: 390 },
  { width: 768, height: 1024, visibleHeight: 440 },
];

test.each(viewports.flatMap((viewport) => [3, 10].map((lines) => ({ ...viewport, lines }))))("keeps a $lines-line draft clickable with all notices at $width × $height (visible $visibleHeight)", async ({ width, height, visibleHeight, lines }) => {
  await page.viewport(width, height);
  const viewport = Object.assign(new EventTarget(), { height, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  const onSend = vi.fn();
  const screen = await render(<PwaUiProvider><NoticeLayoutHarness onSend={onSend} initialDraft={"A draft line\n".repeat(lines).trim()} /></PwaUiProvider>);
  // Toast 是标题区下方的浮层，不参与这里的文档流通知布局，另见 pwa-operation-notifications 测试。
  expect(document.querySelectorAll(".pwa-root")).toHaveLength(1);
  await expect.element(screen.getByRole("status", { name: "Install Pi Reach" })).toBeVisible();
  if (visibleHeight < height) {
    (screen.getByPlaceholder("Message your agent…").element() as HTMLElement).focus({ preventScroll: true });
    viewport.height = visibleHeight;
    viewport.dispatchEvent(new Event("resize"));
  }
  // Portal 挂载通知后，再等布局观察器完成输入区预算与阅读区同步。
  for (let frame = 0; frame < 6; frame += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const runtimeNotice = document.querySelector<HTMLElement>(".pwa-runtime-notice")!;
  const slot = document.querySelector<HTMLElement>(".pwa-runtime-notice-slot")!;
  expect(runtimeNotice.parentElement).toBe(slot);
  expect(document.querySelector(".pwa-runtime-notice-fallback")!.getBoundingClientRect().height).toBe(0);
  const composer = document.querySelector(".pwa-composer-card")!;
  const input = screen.getByPlaceholder("Message your agent…");
  const send = screen.getByRole("button", { name: "Send message", exact: true });
  for (const target of [input.element(), send.element()]) {
    const box = target.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(visibleHeight);
    expect(target.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))).toBe(true);
  }
  const composerBox = composer.getBoundingClientRect();
  expect(document.querySelector(".pwa-connection-banner")).not.toBeNull();
  const retry = screen.getByRole("button", { name: "Retry now" }).element();
  const retryBox = retry.getBoundingClientRect();
  expect(retryBox.height).toBeGreaterThanOrEqual(44);
  expect(retryBox.width).toBeGreaterThanOrEqual(44);
  expect(retry.contains(document.elementFromPoint(retryBox.x + retryBox.width / 2, retryBox.y + retryBox.height / 2))).toBe(true);
  const runtimeBox = runtimeNotice.getBoundingClientRect();
  expect(runtimeBox.top).toBeGreaterThanOrEqual(document.querySelector(".pwa-toast")!.getBoundingClientRect().bottom);
  expect(runtimeBox.bottom).toBeLessThanOrEqual(document.querySelector(".pwa-message-list")!.getBoundingClientRect().top);
  for (const name of ["Install app", "Dismiss PWA notice"]) {
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
  expect(listBox.height).toBeGreaterThanOrEqual(40);
  expect(document.querySelector("[data-composer-budget='conflict']")).toBeNull();
  const contentRange = document.createRange();
  contentRange.selectNodeContents(list);
  const contentBox = contentRange.getBoundingClientRect();
  expect(contentBox.bottom).toBeLessThanOrEqual(listBox.bottom);
  expect(list.contains(document.elementFromPoint(contentBox.x + contentBox.width / 2, contentBox.y + contentBox.height / 2))).toBe(true);
  for (const notice of document.querySelectorAll(".pwa-runtime-notice,.pwa-connection-banner,.pwa-toast")) {
    const box = notice.getBoundingClientRect();
    expect(box.bottom <= composerBox.top || box.top >= composerBox.bottom, JSON.stringify({ notice: notice.className, noticeBox: box.toJSON(), composerBox: composerBox.toJSON() })).toBe(true);
  }
  await input.click();
  await expect.element(input).toHaveFocus();
  if (lines === 10) {
    expect(input.element().scrollHeight).toBeGreaterThan(input.element().clientHeight);
    expect(getComputedStyle(input.element()).overflowY).toMatch(/auto|scroll/);
  }
  if (lines === 10) await page.screenshot({ path: `../../../.vitest/screenshots/brand-gap-notices-${width}x${height}-visible-${visibleHeight}.png` });
  await send.click();
  expect(onSend).toHaveBeenCalledOnce();
  await screen.getByRole("button", { name: "Dismiss", exact: true }).click();
  input.element().focus();
  const dismissRuntime = screen.getByRole("button", { name: "Dismiss PWA notice", exact: true });
  dismissRuntime.element().focus();
  await dismissRuntime.click();
  await expect.element(input).toHaveFocus();
  expect(slot.getBoundingClientRect().height).toBe(0);
  await expect.element(input).toHaveValue("A draft line\n".repeat(lines).trim());
  await send.click();
  expect(onSend).toHaveBeenCalledTimes(2);
  await screen.unmount();
});
