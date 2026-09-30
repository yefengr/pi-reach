import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { renderPwa } from "@/test/browser/render";
import { PwaAppShell, PwaRuntimeNoticeSlot } from "./pwa-app-shell";
import { PwaUiProvider } from "./pwa-ui-provider";
import { ServiceWorkerNotice, ServiceWorkerRegister } from "./service-worker-register";

const { refreshPwaApp } = vi.hoisted(() => ({ refreshPwaApp: vi.fn() }));

vi.mock("@/lib/pwa/service-worker-update", () => ({ refreshPwaApp }));

type NoticeHarnessProps = {
  installPrompt?: boolean;
  unsupported?: boolean;
  onInstall?: () => void;
  onDismiss?: () => void;
};

function NoticeHarness({
  installPrompt = false,
  unsupported = false,
  onInstall = () => {},
  onDismiss = () => {},
}: NoticeHarnessProps) {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;

  return (
    <ServiceWorkerNotice
      installPrompt={installPrompt}
      unsupported={unsupported}
      onInstall={onInstall}
      onDismiss={() => {
        onDismiss();
        setVisible(false);
      }}
    />
  );
}

type FakeWorker = EventTarget & { state: ServiceWorkerState };
type FakeRegistration = EventTarget & {
  waiting: FakeWorker | null;
  installing: FakeWorker | null;
};
type FakeServiceWorkerContainer = {
  controller: ServiceWorker | null;
  register: ReturnType<typeof vi.fn>;
};

const DEV_SW_CLEANUP_KEY = "pi-reach-dev-sw-cleanup-v1";
const navigatorPrototype = Object.getPrototypeOf(navigator);
const originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
const originalPrototypeServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigatorPrototype, "serviceWorker");

function createWorker(state: ServiceWorkerState = "installed"): FakeWorker {
  return Object.assign(new EventTarget(), { state });
}

function createRegistration({
  waiting = null,
  installing = null,
}: Partial<Pick<FakeRegistration, "waiting" | "installing">> = {}): FakeRegistration {
  return Object.assign(new EventTarget(), { waiting, installing });
}

function installServiceWorker(registration: FakeRegistration, controller: ServiceWorker | null = {} as ServiceWorker) {
  const register = vi.fn(async () => registration as unknown as ServiceWorkerRegistration);
  const serviceWorker: FakeServiceWorkerContainer = { controller, register };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: serviceWorker,
  });
  return { register, serviceWorker };
}

function restoreServiceWorkerApi() {
  if (originalServiceWorkerDescriptor) {
    Object.defineProperty(navigator, "serviceWorker", originalServiceWorkerDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "serviceWorker");
  }
  if (originalPrototypeServiceWorkerDescriptor) {
    Object.defineProperty(navigatorPrototype, "serviceWorker", originalPrototypeServiceWorkerDescriptor);
  } else {
    Reflect.deleteProperty(navigatorPrototype, "serviceWorker");
  }
}

function removeServiceWorkerApi() {
  Reflect.deleteProperty(navigator, "serviceWorker");
  return Reflect.deleteProperty(navigatorPrototype, "serviceWorker");
}

function createInstallPrompt(outcome: "accepted" | "dismissed") {
  const prompt = vi.fn(async () => {});
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome }),
  });
  return { event, prompt };
}

// Vite 编译时替换 NODE_ENV；生产生命周期通过 NODE_ENV=production 单独运行。
const productionTest = test.runIf(process.env.NODE_ENV === "production");

async function waitForRegistration(register: ReturnType<typeof vi.fn>, calls = 1) {
  await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(calls));
}

function ServiceWorkerShellHarness() {
  const [workspaceSlotVisible, setWorkspaceSlotVisible] = useState(false);
  return <PwaUiProvider><PwaAppShell runtimeNotice={<ServiceWorkerRegister />}>
    {workspaceSlotVisible ? <div className="pwa-root"><PwaRuntimeNoticeSlot /></div> : <div className="pwa-loading">
      <button type="button" onClick={() => setWorkspaceSlotVisible(true)}>Show workspace slot</button>
    </div>}
  </PwaAppShell></PwaUiProvider>;
}

beforeEach(async () => {
  sessionStorage.removeItem(DEV_SW_CLEANUP_KEY);
  await page.viewport(1280, 900);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  refreshPwaApp.mockReset();
  restoreServiceWorkerApi();
  sessionStorage.removeItem(DEV_SW_CLEANUP_KEY);
  await page.viewport(1280, 900);
});

test("renders an accessible install notice and routes install and dismiss actions", async () => {
  const onInstall = vi.fn();
  const onDismiss = vi.fn();
  const screen = await renderPwa(
    <NoticeHarness installPrompt onInstall={onInstall} onDismiss={onDismiss} />,
  );
  const notice = screen.getByRole("status");

  await expect.element(notice).toBeVisible();
  await expect.element(screen.getByText("Install Pi Reach")).toBeVisible();
  await expect.element(screen.getByText("Open this workspace from your device launcher.")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Refresh" })).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Install app" }).click();
  expect(onInstall).toHaveBeenCalledTimes(1);

  await screen.getByRole("button", { name: "Dismiss PWA notice" }).click();
  expect(onDismiss).toHaveBeenCalledTimes(1);
  await expect.element(notice).not.toBeInTheDocument();
});

test("keeps the notice dismiss action at a 44px touch target", async () => {
  const screen = await renderPwa(<NoticeHarness unsupported />);
  const dismiss = screen.getByRole("button", { name: "Dismiss PWA notice" });
  await expect.element(dismiss).toBeVisible();
  const rect = dismiss.element().getBoundingClientRect();

  expect(rect.width).toBeGreaterThanOrEqual(44);
  expect(rect.height).toBeGreaterThanOrEqual(44);
});

test("does not put update actions into the persistent install notice", async () => {
  const screen = await renderPwa(<NoticeHarness installPrompt />);
  await expect.element(screen.getByText("Install Pi Reach")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
});

test("shows only Dismiss when offline app mode is unsupported", async () => {
  const onDismiss = vi.fn();
  const screen = await renderPwa(<NoticeHarness unsupported onDismiss={onDismiss} />);

  await expect.element(screen.getByText("Offline app mode unavailable")).toBeVisible();
  await expect.element(screen.getByText(/cannot provide PWA offline startup/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Install app" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Refresh" })).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Dismiss PWA notice" }).click();
  expect(onDismiss).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
});

test("keeps install actions independently routed", async () => {
  const onInstall = vi.fn();
  const screen = await renderPwa(<NoticeHarness installPrompt onInstall={onInstall} />);
  await screen.getByRole("button", { name: "Install app" }).click();
  expect(onInstall).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
});

test("keeps the mobile runtime notice and all actions inside a 390 by 844 viewport", async () => {
  await page.viewport(390, 844);
  const screen = await renderPwa(<NoticeHarness installPrompt />);
  const notice = screen.getByRole("status");
  await expect.element(notice).toBeVisible();
  const noticeRect = notice.element().getBoundingClientRect();

  expect(noticeRect.left).toBeGreaterThanOrEqual(0);
  expect(noticeRect.top).toBeGreaterThanOrEqual(0);
  expect(noticeRect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(noticeRect.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(notice.element().scrollWidth).toBeLessThanOrEqual(notice.element().clientWidth);

  for (const name of ["Install app", "Dismiss PWA notice"]) {
    const action = screen.getByRole("button", { name });
    await expect.element(action).toBeVisible();
    const rect = action.element().getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(noticeRect.left);
    expect(rect.right).toBeLessThanOrEqual(noticeRect.right);
    expect(rect.top).toBeGreaterThanOrEqual(noticeRect.top);
    expect(rect.bottom).toBeLessThanOrEqual(noticeRect.bottom);
  }
});

test("gives unsupported runtime text priority while retaining the install action", async () => {
  const screen = await renderPwa(<NoticeHarness unsupported installPrompt />);

  await expect.element(screen.getByText("Offline app mode unavailable")).toBeVisible();
  await expect.element(screen.getByText(/cannot provide PWA offline startup/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Install app" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
});

productionTest("registers the production service worker at the app scope and reports an existing waiting worker", async () => {
  const registration = createRegistration({ waiting: createWorker() });
  const { register } = installServiceWorker(registration);
  const screen = await renderPwa(<ServiceWorkerRegister />);

  try {
    await expect.element(screen.getByText("Pi Reach update ready")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Dismiss PWA notice" })).not.toBeInTheDocument();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/app" });
  } finally {
    await screen.unmount();
  }
});

productionTest("only reports updatefound after installation when an existing controller is present", async () => {
  const firstInstallWorker = createWorker("installing");
  const firstInstallRegistration = createRegistration();
  const firstInstallListener = vi.spyOn(firstInstallRegistration, "addEventListener");
  installServiceWorker(firstInstallRegistration, null);
  const firstScreen = await renderPwa(<ServiceWorkerRegister />);

  try {
    await vi.waitFor(() => expect(firstInstallListener).toHaveBeenCalledWith("updatefound", expect.any(Function)));
    firstInstallRegistration.installing = firstInstallWorker;
    firstInstallRegistration.dispatchEvent(new Event("updatefound"));
    firstInstallRegistration.waiting = firstInstallWorker;
    firstInstallWorker.state = "installed";
    firstInstallWorker.dispatchEvent(new Event("statechange"));
    await expect.element(firstScreen.getByRole("status")).not.toBeInTheDocument();
  } finally {
    await firstScreen.unmount();
  }

  const updateWorker = createWorker("installing");
  const updateRegistration = createRegistration();
  const updateListener = vi.spyOn(updateRegistration, "addEventListener");
  installServiceWorker(updateRegistration);
  const updateScreen = await renderPwa(<ServiceWorkerRegister />);

  try {
    await vi.waitFor(() => expect(updateListener).toHaveBeenCalledWith("updatefound", expect.any(Function)));
    updateRegistration.installing = updateWorker;
    updateRegistration.dispatchEvent(new Event("updatefound"));
    updateRegistration.waiting = updateWorker;
    updateWorker.state = "installed";
    updateWorker.dispatchEvent(new Event("statechange"));
    await expect.element(updateScreen.getByText("Pi Reach update ready")).toBeVisible();
  } finally {
    await updateScreen.unmount();
  }
});

productionTest("shows unsupported runtime notice for a missing API and a rejected registration", async () => {
  expect(removeServiceWorkerApi()).toBe(true);
  const missingApiScreen = await renderPwa(<ServiceWorkerRegister />);

  try {
    await expect.element(missingApiScreen.getByText("Offline app mode unavailable")).toBeVisible();
  } finally {
    await missingApiScreen.unmount();
  }

  restoreServiceWorkerApi();
  const registration = createRegistration();
  const { register } = installServiceWorker(registration);
  register.mockRejectedValueOnce(new Error("registration rejected"));
  const rejectedScreen = await renderPwa(<ServiceWorkerRegister />);

  try {
    await expect.element(rejectedScreen.getByText("Offline app mode unavailable")).toBeVisible();
  } finally {
    await rejectedScreen.unmount();
  }
});

productionTest("clears captured install prompts after either choice and after installation completes", async () => {
  const { register } = installServiceWorker(createRegistration());
  const screen = await renderPwa(<ServiceWorkerRegister />);

  try {
    await waitForRegistration(register);
    for (const outcome of ["accepted", "dismissed"] as const) {
      const installPrompt = createInstallPrompt(outcome);
      window.dispatchEvent(installPrompt.event);
      await expect.element(screen.getByRole("button", { name: "Install app" })).toBeVisible();
      expect(installPrompt.event.defaultPrevented).toBe(true);

      await screen.getByRole("button", { name: "Install app" }).click();
      expect(installPrompt.prompt).toHaveBeenCalledTimes(1);
      await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
    }

    const installedPrompt = createInstallPrompt("accepted");
    window.dispatchEvent(installedPrompt.event);
    await expect.element(screen.getByRole("button", { name: "Install app" })).toBeVisible();
    window.dispatchEvent(new Event("appinstalled"));
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
    expect(installedPrompt.prompt).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

productionTest("keeps a dismissed notice hidden for the mount while allowing a remount to show a new event", async () => {
  const { register } = installServiceWorker(createRegistration());
  const firstScreen = await renderPwa(<ServiceWorkerRegister />);

  try {
    await waitForRegistration(register);
    const firstPrompt = createInstallPrompt("accepted");
    window.dispatchEvent(firstPrompt.event);
    await expect.element(firstScreen.getByRole("status")).toBeVisible();
    await firstScreen.getByRole("button", { name: "Dismiss PWA notice" }).click();
    await expect.element(firstScreen.getByRole("status")).not.toBeInTheDocument();

    const ignoredPrompt = createInstallPrompt("accepted");
    window.dispatchEvent(ignoredPrompt.event);
    expect(ignoredPrompt.event.defaultPrevented).toBe(true);
    await expect.element(firstScreen.getByRole("status")).not.toBeInTheDocument();
  } finally {
    await firstScreen.unmount();
  }

  const remountedScreen = await renderPwa(<ServiceWorkerRegister />);
  try {
    await waitForRegistration(register, 2);
    const remountedPrompt = createInstallPrompt("dismissed");
    window.dispatchEvent(remountedPrompt.event);
    await expect.element(remountedScreen.getByRole("button", { name: "Install app" })).toBeVisible();
  } finally {
    await remountedScreen.unmount();
  }
});

productionTest("keeps an existing update request while its Toast moves from the shell fallback to a workspace slot", async () => {
  const registration = createRegistration({ waiting: createWorker() });
  const { register } = installServiceWorker(registration);
  const screen = await render(<ServiceWorkerShellHarness />);

  try {
    const refresh = screen.getByRole("button", { name: "Refresh" });
    await expect.element(refresh).toBeVisible();
    await expect.poll(() => document.querySelector<HTMLElement>(".pwa-toast-fallback-root .pwa-operation-notification")).not.toBeNull();
    await refresh.click();
    expect(refreshPwaApp).toHaveBeenCalledOnce();
    expect(refreshPwaApp).toHaveBeenCalledWith(registration);
    await expect.element(screen.getByRole("button", { name: "Updating" })).toBeDisabled();

    await screen.getByRole("button", { name: "Show workspace slot" }).click();
    await expect.poll(() => document.querySelector<HTMLElement>(".pwa-root .pwa-operation-notification")).not.toBeNull();
    await expect.element(screen.getByRole("button", { name: "Updating" })).toBeDisabled();
    expect(document.querySelectorAll(".pwa-operation-notification")).toHaveLength(1);
    expect(register).toHaveBeenCalledTimes(1);
  } finally {
    await screen.unmount();
  }
});

productionTest("does not reset dismissal or register again when the shell workspace slot appears", async () => {
  const { register } = installServiceWorker(createRegistration());
  const screen = await render(<ServiceWorkerShellHarness />);

  try {
    await waitForRegistration(register);
    const prompt = createInstallPrompt("accepted");
    window.dispatchEvent(prompt.event);
    await expect.element(screen.getByRole("status")).toBeVisible();
    await screen.getByRole("button", { name: "Dismiss PWA notice" }).click();
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "Show workspace slot" }).click();
    const ignoredPrompt = createInstallPrompt("dismissed");
    window.dispatchEvent(ignoredPrompt.event);
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
    expect(register).toHaveBeenCalledTimes(1);
  } finally {
    await screen.unmount();
  }
});

productionTest("does not steal focus when an install prompt appears and restores its source on dismissal", async () => {
  const { register } = installServiceWorker(createRegistration());
  const screen = await renderPwa(<><button type="button">Workspace action</button><ServiceWorkerRegister /></>);

  try {
    await waitForRegistration(register);
    const source = screen.getByRole("button", { name: "Workspace action" });
    source.element().focus();
    await expect.element(source).toHaveFocus();

    const prompt = createInstallPrompt("accepted");
    window.dispatchEvent(prompt.event);
    await expect.element(screen.getByRole("status")).toBeVisible();
    await expect.element(source).toHaveFocus();

    await screen.getByRole("button", { name: "Dismiss PWA notice" }).click();
    await expect.element(source).toHaveFocus();
  } finally {
    await screen.unmount();
  }
});

productionTest("restores focus after installing when refresh remains available", async () => {
  const { register } = installServiceWorker(createRegistration({ waiting: createWorker() }));
  const screen = await renderPwa(<><button type="button">Workspace action</button><ServiceWorkerRegister /></>);

  try {
    await waitForRegistration(register);
    const source = screen.getByRole("button", { name: "Workspace action" });
    const prompt = createInstallPrompt("accepted");
    window.dispatchEvent(prompt.event);
    const install = screen.getByRole("button", { name: "Install app" });
    await expect.element(install).toBeVisible();
    source.element().focus();
    install.element().focus();
    await expect.element(install).toHaveFocus();

    await install.click();
    await expect.element(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect.element(source).toHaveFocus();
  } finally {
    await screen.unmount();
  }
});

productionTest("does not move refresh or Toast close focus for appinstalled when no install prompt is available", async () => {
  installServiceWorker(createRegistration({ waiting: createWorker() }));
  const screen = await renderPwa(<ServiceWorkerRegister />);

  try {
    const refresh = screen.getByRole("button", { name: "Refresh" });
    await expect.element(refresh).toBeVisible();
    refresh.element().focus();
    window.dispatchEvent(new Event("appinstalled"));
    await expect.element(refresh).toHaveFocus();

    const dismiss = screen.getByRole("button", { name: "Dismiss operation notification" });
    dismiss.element().focus();
    window.dispatchEvent(new Event("appinstalled"));
    await expect.element(dismiss).toHaveFocus();
  } finally {
    await screen.unmount();
  }
});

productionTest("removes registration and window listeners on unmount so stale events cannot update it", async () => {
  const registration = createRegistration();
  const removeUpdateFound = vi.spyOn(registration, "removeEventListener");
  const staleWorker = createWorker("installing");
  const workerStateListener = vi.spyOn(staleWorker, "addEventListener");
  const { register } = installServiceWorker(registration);
  const screen = await renderPwa(<ServiceWorkerRegister />);

  await waitForRegistration(register);
  await screen.unmount();

  const stalePrompt = createInstallPrompt("accepted");
  window.dispatchEvent(stalePrompt.event);
  registration.installing = staleWorker;
  registration.dispatchEvent(new Event("updatefound"));
  staleWorker.state = "installed";
  staleWorker.dispatchEvent(new Event("statechange"));
  window.dispatchEvent(new Event("appinstalled"));

  expect(stalePrompt.event.defaultPrevented).toBe(false);
  expect(removeUpdateFound).toHaveBeenCalledWith("updatefound", expect.any(Function));
  expect(workerStateListener).not.toHaveBeenCalled();
});

test.runIf(process.env.NODE_ENV !== "production")("keeps the development cleanup path invisible and unregisters only once per session", async () => {
  const unregister = vi.fn(async () => true);
  const getRegistrations = vi.fn(async () => [{ unregister }]);
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistrations },
  });
  const firstScreen = await renderPwa(<ServiceWorkerRegister />);

  try {
    await vi.waitFor(() => expect(getRegistrations).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(unregister).toHaveBeenCalledTimes(1));
    await expect.element(firstScreen.getByRole("status")).not.toBeInTheDocument();
  } finally {
    await firstScreen.unmount();
  }

  const secondScreen = await renderPwa(<ServiceWorkerRegister />);
  try {
    await expect.element(secondScreen.getByRole("status")).not.toBeInTheDocument();
    expect(getRegistrations).toHaveBeenCalledTimes(1);
  } finally {
    await secondScreen.unmount();
  }
});
