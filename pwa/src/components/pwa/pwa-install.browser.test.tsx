import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { PwaInstallContext, PwaInstallProvider, usePwaInstall, type InstallOffer, type PwaInstallState } from "./pwa-install";
import { SettingsPage } from "./settings-page";
import { UnpairedWorkspace } from "./workspace-content";
import { minimumControlHeight } from "@/test/browser/button-height";

const navigatorPrototype = Object.getPrototypeOf(navigator);
const originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
const originalPrototypeServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigatorPrototype, "serviceWorker");
const IPHONE_SAFARI_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

/** 模拟 iPhone Safari；`standalone` 表示已从主屏幕打开。 */
function emulateIphoneSafari({ standalone = false } = {}) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_SAFARI_USER_AGENT);
  vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(5);
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => (
    query === "(display-mode: standalone)" ? { ...matchMedia(query), matches: standalone } : matchMedia(query)
  ));
}

function restoreServiceWorkerApi() {
  if (originalServiceWorkerDescriptor) Object.defineProperty(navigator, "serviceWorker", originalServiceWorkerDescriptor);
  else Reflect.deleteProperty(navigator, "serviceWorker");
  if (originalPrototypeServiceWorkerDescriptor) Object.defineProperty(navigatorPrototype, "serviceWorker", originalPrototypeServiceWorkerDescriptor);
  else Reflect.deleteProperty(navigatorPrototype, "serviceWorker");
}

function createInstallPrompt(outcome: "accepted" | "dismissed") {
  const prompt = vi.fn(async () => {});
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome }),
  });
  return { event, prompt };
}

function OfferProbe() {
  const { offer } = usePwaInstall();
  return <output data-testid="offer">{offer ?? "none"}</output>;
}

/** 受控安装状态：只验证呈现与回调，不依赖浏览器事件。 */
function withInstall(offer: InstallOffer | null, ui: ReactNode, overrides: Partial<PwaInstallState> = {}) {
  const value: PwaInstallState = { offer, deferred: false, setDeferred: () => {}, install: async () => {}, ...overrides };
  return <PwaInstallContext.Provider value={value}>{ui}</PwaInstallContext.Provider>;
}

function Settings() {
  return <div className="pwa-settings-view"><SettingsPage
    relayUrl="https://relay.example.test"
    defaultRelayUrl="https://relay.example.test"
    relayVersion={null}
    relayStatus="offline"
    extensionVersion={null}
    extensionStatus="offline"
    extensionTarget={null}
    onSave={async () => {}}
    onBack={() => {}}
    backLabel="Back to workspace"
    onClearData={() => {}}
    onResetLayout={() => {}}
    onShowShortcuts={() => {}}
  /></div>;
}

/** 跳过状态由测试组件持有，与 Provider 一样只在本次挂载期间生效。 */
function DeferrableInstall({ offer }: { offer: InstallOffer }) {
  const [deferred, setDeferred] = useState(false);
  return withInstall(offer, <UnpairedWorkspace onPair={() => {}} />, { deferred, setDeferred });
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreServiceWorkerApi();
});

test("captures the browser install prompt and clears it after either choice or installation", async () => {
  const screen = await renderPwa(<PwaInstallProvider><OfferProbe /><UnpairedWorkspace onPair={() => {}} /></PwaInstallProvider>);
  try {
    await expect.element(screen.getByTestId("offer")).toHaveTextContent("none");
    for (const outcome of ["accepted", "dismissed"] as const) {
      const installPrompt = createInstallPrompt(outcome);
      window.dispatchEvent(installPrompt.event);
      expect(installPrompt.event.defaultPrevented).toBe(true);
      await expect.element(screen.getByTestId("offer")).toHaveTextContent("prompt");

      await screen.getByRole("button", { name: "Install app" }).click();
      expect(installPrompt.prompt).toHaveBeenCalledTimes(1);
      await expect.element(screen.getByTestId("offer")).toHaveTextContent("none");
    }

    const installedPrompt = createInstallPrompt("accepted");
    window.dispatchEvent(installedPrompt.event);
    await expect.element(screen.getByTestId("offer")).toHaveTextContent("prompt");
    window.dispatchEvent(new Event("appinstalled"));
    await expect.element(screen.getByTestId("offer")).toHaveTextContent("none");
    expect(installedPrompt.prompt).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }

  const stalePrompt = createInstallPrompt("accepted");
  window.dispatchEvent(stalePrompt.event);
  expect(stalePrompt.event.defaultPrevented).toBe(false);
});

test("offers the manual Home Screen guide only in an iPhone browser tab with Service Worker support", async () => {
  emulateIphoneSafari();
  let screen = await renderPwa(<PwaInstallProvider><OfferProbe /></PwaInstallProvider>);
  await expect.element(screen.getByTestId("offer")).toHaveTextContent("ios");
  await screen.unmount();

  vi.restoreAllMocks();
  emulateIphoneSafari({ standalone: true });
  screen = await renderPwa(<PwaInstallProvider><OfferProbe /></PwaInstallProvider>);
  await expect.element(screen.getByTestId("offer")).toHaveTextContent("none");
  await screen.unmount();

  vi.restoreAllMocks();
  emulateIphoneSafari();
  Reflect.deleteProperty(navigator, "serviceWorker");
  Reflect.deleteProperty(navigatorPrototype, "serviceWorker");
  screen = await renderPwa(<PwaInstallProvider><OfferProbe /></PwaInstallProvider>);
  await expect.element(screen.getByTestId("offer")).toHaveTextContent("none");
  await screen.unmount();
});

test("keeps the single pairing state when Pi Reach cannot be installed from this tab", async () => {
  const screen = await renderPwa(withInstall(null, <UnpairedWorkspace onPair={() => {}} />));
  await expect.element(screen.getByRole("heading", { name: "No computers paired yet" })).toBeVisible();
  await expect.element(screen.getByText(/^Step \d of 2$/)).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Start pairing" })).toHaveAttribute("data-variant", "filled");
});

test("walks an iPhone user through installing and pairing as two separate steps", async () => {
  const screen = await renderPwa(<DeferrableInstall offer="ios" />);

  const installHeading = screen.getByRole("heading", { name: "Add to Home Screen" });
  await expect.element(installHeading).toBeVisible();
  await expect.element(screen.getByText("Step 1 of 2")).toBeVisible();
  await expect.element(screen.getByText("Open your browser's Share menu")).toBeVisible();
  await expect.element(screen.getByText("Open Pi Reach from your Home Screen, then pair your computer")).toBeVisible();
  // 一屏只做一件事：安装这一步没有配对命令与配对按钮，手动添加也没有安装按钮。
  await expect.element(screen.getByRole("button", { name: "Start pairing" })).not.toBeInTheDocument();
  await expect.element(screen.getByText("/pi-reach pair")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Install app" })).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Use in browser for now" }).click();
  const pairHeading = screen.getByRole("heading", { name: "Pair a computer" });
  await expect.element(pairHeading).toHaveFocus();
  await expect.element(screen.getByText("Step 2 of 2")).toBeVisible();
  await expect.element(screen.getByText("/pi-reach pair")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Start pairing" })).toHaveAttribute("data-variant", "filled");
  await expect.element(screen.getByRole("heading", { name: "Add to Home Screen" })).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Back to install steps" }).click();
  await expect.element(screen.getByRole("heading", { name: "Add to Home Screen" })).toHaveFocus();
  await expect.element(screen.getByRole("button", { name: "Start pairing" })).not.toBeInTheDocument();
});

test("hands focus to pairing after the install prompt removes the install step", async () => {
  const screen = await renderPwa(<PwaInstallProvider><UnpairedWorkspace onPair={() => {}} /></PwaInstallProvider>);
  const installPrompt = createInstallPrompt("accepted");
  window.dispatchEvent(installPrompt.event);
  const install = screen.getByRole("button", { name: "Install app" });
  await expect.element(install).toBeVisible();
  await expect.element(screen.getByText("Open it straight from your device launcher, separate from your browser tabs.")).toBeVisible();

  await install.click();
  await expect.element(screen.getByRole("heading", { name: "No computers paired yet" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Start pairing" })).toHaveFocus();
});

test("fits the install step and its actions inside a 390px phone width", async () => {
  await page.viewport(390, 844);
  const screen = await renderPwa(withInstall("prompt", <div className="pwa-main"><UnpairedWorkspace onPair={() => {}} /></div>));
  await expect.element(screen.getByRole("button", { name: "Install app" })).toBeVisible();
  const state = document.querySelector<HTMLElement>(".pwa-onboarding")!;
  expect(state.scrollWidth).toBeLessThanOrEqual(state.clientWidth);
  for (const name of ["Install app", "Use in browser for now"]) {
    const action = screen.getByRole("button", { name }).element();
    expect(Math.round(action.getBoundingClientRect().height)).toBeGreaterThanOrEqual(minimumControlHeight(action));
  }
});

test("shows the App section in Settings only while Pi Reach can be installed", async () => {
  let screen = await renderPwa(withInstall(null, <Settings />));
  await expect.element(screen.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "App", exact: true })).not.toBeInTheDocument();
  await screen.unmount();

  screen = await renderPwa(withInstall("mac-safari", <Settings />));
  const section = screen.getByRole("region", { name: "App", exact: true });
  await expect.element(section).toBeVisible();
  await expect.element(section.getByText("Add to Dock", { exact: true })).toBeVisible();
  await expect.element(section.getByText("In the menu bar, choose File > Add to Dock")).toBeVisible();
  await expect.element(section.getByText("Open Pi Reach from the Dock", { exact: true })).toBeVisible();
  await expect.element(section.getByRole("button", { name: "Install app" })).not.toBeInTheDocument();
  // 应用分区位于外观之前。
  const headings = [...document.querySelectorAll(".pwa-settings-section-title")].map((heading) => heading.textContent);
  expect(headings.slice(0, 2)).toEqual(["App", "Appearance"]);
  await screen.unmount();
});

test("installs from Settings and returns focus to the page title when the section disappears", async () => {
  const screen = await renderPwa(<PwaInstallProvider><Settings /></PwaInstallProvider>);
  const installPrompt = createInstallPrompt("accepted");
  window.dispatchEvent(installPrompt.event);
  const install = screen.getByRole("button", { name: "Install app" });
  await expect.element(install).toBeVisible();

  await install.click();
  expect(installPrompt.prompt).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByRole("region", { name: "App", exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("heading", { name: "Settings", level: 1 })).toHaveFocus();
});
