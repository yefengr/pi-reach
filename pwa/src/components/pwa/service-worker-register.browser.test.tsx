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

function NoticeHarness({ onDismiss = () => {} }: { onDismiss?: () => void }) {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;

  return (
    <ServiceWorkerNotice
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

test("keeps the notice dismiss action at a 44px touch target", async () => {
  const screen = await renderPwa(<NoticeHarness />);
  const dismiss = screen.getByRole("button", { name: "Dismiss PWA notice" });
  await expect.element(dismiss).toBeVisible();
  const rect = dismiss.element().getBoundingClientRect();

  expect(rect.width).toBeGreaterThanOrEqual(44);
  expect(rect.height).toBeGreaterThanOrEqual(44);
});

test("runtime notice keeps the reading width in the shell fallback", async () => {
  // 启动与故障态没有 .pwa-root，提示条落在应用壳 fallback，仍需读取全局阅读列宽。
  const screen = await render(
    <PwaUiProvider><PwaAppShell runtimeNotice={<NoticeHarness />}>
      <div className="pwa-loading">Loading</div>
    </PwaAppShell></PwaUiProvider>,
  );
  try {
    await expect.poll(() => Math.round(document.querySelector<HTMLElement>(".pwa-runtime-notice-fallback .pwa-runtime-notice")?.getBoundingClientRect().width ?? 0)).toBe(680);
  } finally {
    await screen.unmount();
  }
});

test("shows only Dismiss when offline app mode is unsupported", async () => {
  const onDismiss = vi.fn();
  const screen = await renderPwa(<NoticeHarness onDismiss={onDismiss} />);

  await expect.element(screen.getByText("Offline app mode unavailable")).toBeVisible();
  await expect.element(screen.getByText(/cannot provide PWA offline startup/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Install app" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Refresh" })).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Dismiss PWA notice" }).click();
  expect(onDismiss).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
});

test("keeps the mobile runtime notice and its dismiss action inside a 390 by 844 viewport", async () => {
  await page.viewport(390, 844);
  const screen = await renderPwa(<NoticeHarness />);
  const notice = screen.getByRole("status");
  await expect.element(notice).toBeVisible();
  const noticeRect = notice.element().getBoundingClientRect();

  expect(noticeRect.left).toBeGreaterThanOrEqual(0);
  expect(noticeRect.top).toBeGreaterThanOrEqual(0);
  expect(noticeRect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(noticeRect.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(notice.element().scrollWidth).toBeLessThanOrEqual(notice.element().clientWidth);

  for (const name of ["Dismiss PWA notice"]) {
    const action = screen.getByRole("button", { name });
    await expect.element(action).toBeVisible();
    const rect = action.element().getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(noticeRect.left);
    expect(rect.right).toBeLessThanOrEqual(noticeRect.right);
    expect(rect.top).toBeGreaterThanOrEqual(noticeRect.top);
    expect(rect.bottom).toBeLessThanOrEqual(noticeRect.bottom);
  }
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

productionTest("keeps a dismissed notice hidden for the mount and shows it again on the next open", async () => {
  expect(removeServiceWorkerApi()).toBe(true);
  const firstScreen = await renderPwa(<ServiceWorkerRegister />);

  try {
    await expect.element(firstScreen.getByRole("status")).toBeVisible();
    await firstScreen.getByRole("button", { name: "Dismiss PWA notice" }).click();
    await expect.element(firstScreen.getByRole("status")).not.toBeInTheDocument();
  } finally {
    await firstScreen.unmount();
  }

  const remountedScreen = await renderPwa(<ServiceWorkerRegister />);
  try {
    await expect.element(remountedScreen.getByText("Offline app mode unavailable")).toBeVisible();
  } finally {
    await remountedScreen.unmount();
  }
});

productionTest("leaves install prompts to the install state instead of the runtime notice", async () => {
  const { register } = installServiceWorker(createRegistration());
  const screen = await renderPwa(<ServiceWorkerRegister />);

  try {
    await waitForRegistration(register);
    const event = new Event("beforeinstallprompt", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
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
  register.mockRejectedValueOnce(new Error("registration rejected"));
  const screen = await render(<ServiceWorkerShellHarness />);

  try {
    await waitForRegistration(register);
    await expect.element(screen.getByRole("status")).toBeVisible();
    await screen.getByRole("button", { name: "Dismiss PWA notice" }).click();
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "Show workspace slot" }).click();
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
    expect(register).toHaveBeenCalledTimes(1);
  } finally {
    await screen.unmount();
  }
});

productionTest("does not steal focus when the unsupported notice appears and restores its source on dismissal", async () => {
  const { register } = installServiceWorker(createRegistration());
  let rejectRegistration: (error: Error) => void = () => {};
  register.mockReturnValueOnce(new Promise((_, reject) => { rejectRegistration = reject; }));
  const screen = await renderPwa(<><button type="button">Workspace action</button><ServiceWorkerRegister /></>);

  try {
    await waitForRegistration(register);
    const source = screen.getByRole("button", { name: "Workspace action" });
    source.element().focus();
    await expect.element(source).toHaveFocus();

    rejectRegistration(new Error("registration rejected"));
    await expect.element(screen.getByRole("status")).toBeVisible();
    await expect.element(source).toHaveFocus();

    await screen.getByRole("button", { name: "Dismiss PWA notice" }).click();
    await expect.element(source).toHaveFocus();
  } finally {
    await screen.unmount();
  }
});

productionTest("removes registration listeners on unmount so stale events cannot update it", async () => {
  const registration = createRegistration();
  const removeUpdateFound = vi.spyOn(registration, "removeEventListener");
  const staleWorker = createWorker("installing");
  const workerStateListener = vi.spyOn(staleWorker, "addEventListener");
  const { register } = installServiceWorker(registration);
  const screen = await renderPwa(<ServiceWorkerRegister />);

  await waitForRegistration(register);
  await screen.unmount();

  registration.installing = staleWorker;
  registration.dispatchEvent(new Event("updatefound"));
  staleWorker.state = "installed";
  staleWorker.dispatchEvent(new Event("statechange"));

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
