import { useLayoutEffect, useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { MessageComposer } from "./message-composer";
import { PwaConnectionBanner } from "./pwa-app-actions";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaWorkspaceLayout } from "./pwa-workspace-layout";

const DRAFT = Array.from({ length: 10 }, (_, index) => `Draft line ${index + 1}`).join("\n");
const noop = () => {};

const navigation = {
  devices: [], endpoints: [], history: [],
  activeDeviceId: null, activeEndpointId: null, selectedHistoryId: null,
  snapshotReady: true,
  onPair: noop, onSettings: noop, onSelectDevice: noop, onSelectEndpoint: noop,
  onSelectHistory: noop, onRename: noop, onRemove: noop,
};
const settingsRoute = { open: false, origin: null, animate: false, change: 0 };
const composerProps: ComponentProps<typeof MessageComposer> = {
  enterSends: true, attachments: [], canAttach: true, sendingAttachments: false,
  isOnline: true, isWorking: false, stopping: false, draft: DRAFT,
  onDraftChange: noop, onSend: noop, onStop: noop, onAddFiles: noop,
  onRemoveAttachment: noop, onRetryAttachment: noop,
  commandModels: [], commandCurrentModel: null, commandCurrentModelFallback: null,
  commandThinking: "off", commandPendingAction: null,
  onNewSession: noop, onCompactSession: noop, onSetModel: noop,
  onSetThinking: noop, onCommandsOpen: noop,
};

let setNotice: (visible: boolean) => void = noop;

/** 使用真实工作区与输入组件，仅控制顶部连接提示是否显示。 */
function Harness({ initialNotice = false }: { initialNotice?: boolean }) {
  const [notice, set] = useState(initialNotice);
  useLayoutEffect(() => { setNotice = set; }, [set]);
  return <PwaAppShell runtimeNotice={null}>
    <PwaWorkspaceLayout
      navigation={navigation}
      titleBar={{ title: "Session", showTitle: true }}
      historyMode={false}
      connectionBanner={notice ? <PwaConnectionBanner kind="relay" connection="retrying" /> : null}
      toast={null}
      operationNotifications={null}
      settingsRoute={settingsRoute}
      onOpenSettings={noop}
      onSettingsBack={noop}
      renderSettings={() => null}
      overlays={null}
      closeBackgroundOverlay={(close) => close()}
    >
      <div className="pwa-message-list" role="log">
        {Array.from({ length: 12 }, (_, index) => <p key={index}>Message {index + 1}</p>)}
      </div>
      <div className="pwa-chat-footer"><MessageComposer {...composerProps} /></div>
    </PwaWorkspaceLayout>
  </PwaAppShell>;
}

const pixels = (value: string) => Math.round(Number.parseFloat(value));

/** 只记录输入区预算与随之变化的真实布局，便于失败时直接给出几何差异。 */
function geometry() {
  const main = document.querySelector<HTMLElement>(".pwa-main")!;
  const body = document.querySelector<HTMLElement>(".pwa-workspace-body")!;
  const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
  const footer = document.querySelector<HTMLElement>(".pwa-chat-footer")!;
  const input = document.querySelector<HTMLTextAreaElement>(".pwa-composer-input")!;
  const mainBox = main.getBoundingClientRect();
  const listBox = list.getBoundingClientRect();
  const inputBox = input.getBoundingClientRect();
  const footerBox = footer.getBoundingClientRect();
  const footerChrome = footerBox.height - inputBox.height;
  return {
    mainHeight: Math.round(mainBox.height),
    bodyHeight: Math.round(body.getBoundingClientRect().height),
    listTop: Math.round(listBox.top),
    listHeight: Math.round(listBox.height),
    listPaddingTop: pixels(getComputedStyle(list).paddingTop),
    inputHeight: Math.round(inputBox.height),
    inputMaxHeight: pixels(input.style.maxHeight),
    footerChrome: Math.round(footerChrome),
    space: Math.round(mainBox.bottom - listBox.top - footerChrome),
    budget: main.dataset.composerBudget ?? null,
    overflowY: input.style.overflowY,
  };
}

async function settleGeometry(frames = 4) {
  // 仅等待初始 ResizeObserver 与 rAF 合并的有限交接，不通过窗口缩放或重新输入制造测量。
  for (let frame = 0; frame < frames; frame += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

afterEach(async () => { await page.viewport(1280, 900); });

test("showing a notice switches the composer from six lines to the constrained budget and back", async () => {
  await page.viewport(390, 349);
  const screen = await renderPwa(<Harness />);
  try {
    await settleGeometry();
    const input = document.querySelector<HTMLTextAreaElement>(".pwa-composer-input")!;
    input.focus();
    const before = geometry();
    // 无提示时六行仍放得下：预算为空，输入区停在六行上限。
    expect(before.budget).toBe(null);
    expect(before.inputHeight).toBe(before.inputMaxHeight);

    flushSync(() => setNotice(true));
    await expect.poll(() => geometry().listTop, { timeout: 3_000 }).toBeGreaterThan(before.listTop);
    const shown = geometry();
    expect(shown.mainHeight).toBe(before.mainHeight);
    expect(shown.bodyHeight).toBe(before.bodyHeight - (shown.listTop - before.listTop));
    // 主区与输入区自身尺寸没变，只有工作区剩余高度变小，预算必须随之收紧。
    await expect.poll(() => geometry(), { timeout: 3_000 }).toMatchObject({ budget: "constrained" });
    const constrained = geometry();
    expect(constrained.space).toBe(shown.space);
    expect(constrained.inputMaxHeight).toBeLessThan(before.inputMaxHeight);
    expect(constrained.inputHeight).toBe(constrained.inputMaxHeight);
    expect(constrained.overflowY).toBe("auto");

    flushSync(() => setNotice(false));
    await expect.poll(() => geometry().listTop, { timeout: 3_000 }).toBe(before.listTop);
    await expect.poll(() => geometry(), { timeout: 3_000 }).toMatchObject({ budget: null });
    const restored = geometry();
    expect(restored).toMatchObject({
      inputMaxHeight: before.inputMaxHeight,
      inputHeight: before.inputHeight,
      bodyHeight: before.bodyHeight,
      listHeight: before.listHeight,
    });
    expect(document.querySelector(".pwa-composer-input")).toBe(input);
    expect(input.value).toBe(DRAFT);
    expect(document.activeElement).toBe(input);
  } finally { await screen.unmount(); }
});

test("removing an initial notice restores the composer height and budget of a notice-free mount", async () => {
  await page.viewport(390, 300);
  const baselineScreen = await renderPwa(<Harness />);
  let baseline: ReturnType<typeof geometry>;
  try {
    await settleGeometry();
    baseline = geometry();
    expect(baseline.budget).toBe("constrained");
  } finally { await baselineScreen.unmount(); }

  const screen = await renderPwa(<Harness initialNotice />);
  try {
    await settleGeometry();
    const input = document.querySelector<HTMLTextAreaElement>(".pwa-composer-input")!;
    input.focus();
    const noticed = geometry();
    expect(noticed.budget).toBe("constrained");
    expect(noticed.inputMaxHeight).toBeLessThan(baseline.inputMaxHeight);
    expect(noticed.inputHeight).toBe(noticed.inputMaxHeight);
    expect(noticed.overflowY).toBe("auto");

    flushSync(() => setNotice(false));
    await expect.poll(() => geometry().listTop, { timeout: 3_000 }).toBe(baseline.listTop);
    await expect.poll(() => geometry(), { timeout: 3_000 }).toMatchObject({ inputMaxHeight: baseline.inputMaxHeight });
    const restored = geometry();
    expect(restored).toMatchObject({
      inputHeight: baseline.inputHeight,
      bodyHeight: baseline.bodyHeight,
      mainHeight: baseline.mainHeight,
      budget: baseline.budget,
    });
    expect(restored.listHeight).toBeGreaterThan(0);
    expect(document.querySelector(".pwa-composer-input")).toBe(input);
    expect(input.value).toBe(DRAFT);
    expect(document.activeElement).toBe(input);
  } finally { await screen.unmount(); }
});
