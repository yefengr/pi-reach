import { act, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { getMessages, setLanguagePreference } from "@/lib/i18n";
import { createOperationNotificationController } from "@/lib/pwa/operation-notifications";
import { PwaToastProvider } from "./pwa-operation-notifications";
import { CopyButton } from "./copy-button";

type Feedback = "toast" | "inline" | "inline-text";
beforeEach(() => { setLanguagePreference("en"); });
afterEach(async () => {
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty("--pwa-duration-feedback");
  setLanguagePreference("system");
  await page.viewport(1280, 900);
});

async function commit(change: () => void) {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  try { await act(async () => { change(); }); }
  finally { environment.IS_REACT_ACT_ENVIRONMENT = previous; }
}

function pendingCopy() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function fixture(feedback?: Feedback) {
  const controller = createOperationNotificationController();
  const notify = vi.spyOn(controller, "notify").mockImplementation(() => {});
  const screen = await renderPwa(<PwaToastProvider value={controller}><CopyButton text="Pi Reach fixture" label="Copy fixture" feedback={feedback} /></PwaToastProvider>);
  const button = screen.getByRole("button", { name: "Copy fixture", exact: true }).element() as HTMLButtonElement;
  return { screen, button, notify };
}

function hasCheck(button: HTMLElement) {
  return button.querySelector(".pwa-copy-icons")!.hasAttribute("data-copied");
}

function geometry(element: Element) {
  const { x, y, width, height } = element.getBoundingClientRect();
  return [x, y, width, height].map(Math.round);
}

test.each([undefined, "inline", "toast"] as const)("%s feedback waits for clipboard success and keeps button geometry", async (feedback) => {
  const pending = pendingCopy();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(pending.promise);
  const { screen, button, notify } = await fixture(feedback);
  const before = geometry(button);
  await userEvent.click(button);
  expect(write).toHaveBeenCalledWith("Pi Reach fixture");
  expect(button.getAttribute("aria-label")).toBe("Copy fixture");
  expect(notify).not.toHaveBeenCalled();
  if (feedback !== "toast") expect(hasCheck(button)).toBe(false);
  await commit(pending.resolve);
  expect(geometry(button)).toEqual(before);
  if (feedback === "toast") {
    expect(button.getAttribute("aria-label")).toBe(getMessages().workspace.copied);
    expect(notify).toHaveBeenCalledExactlyOnceWith(getMessages().workspace.copied);
    expect(document.querySelector('[role="status"]')).toBeNull();
  } else {
    expect(button.getAttribute("aria-label")).toBe("Copy fixture");
    expect(hasCheck(button)).toBe(true);
    await expect.poll(() => getComputedStyle(button.querySelector(".pwa-copy-icon-check")!).opacity).toBe("1");
    await expect.poll(() => getComputedStyle(button.querySelector(".pwa-copy-icon-copy")!).opacity).toBe("0");
    expect(notify).not.toHaveBeenCalled();
    const live = screen.getByRole("status").element();
    expect(live.textContent).toBe(getMessages().workspace.copied);
    expect(live.classList.contains("pwa-sr-only")).toBe(true);
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(geometry(button.querySelector(".pwa-copy-icons")!).slice(2)).toEqual([16, 16]);
  }
});

test("default repeated success restarts the real two-second feedback independently of animation speed", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const { button, notify } = await fixture();
  document.documentElement.style.setProperty("--pwa-duration-feedback", "10s");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await commit(() => { button.click(); });
  expect(hasCheck(button)).toBe(true);
  await commit(() => { vi.advanceTimersByTime(1500); });
  await commit(() => { button.click(); });
  await commit(() => { vi.advanceTimersByTime(600); });
  expect(hasCheck(button)).toBe(true);
  await commit(() => { vi.advanceTimersByTime(1400); });
  expect(hasCheck(button)).toBe(false);
  expect(button.getAttribute("aria-label")).toBe("Copy fixture");
  expect(notify).not.toHaveBeenCalled();
});

test.each([undefined, "inline"] as const)("%s failure replaces old success with a local error and one announcement", async (feedback) => {
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValueOnce().mockRejectedValueOnce(new Error("private exception details"));
  const { screen, button, notify } = await fixture(feedback);
  await userEvent.click(button);
  await expect.poll(() => hasCheck(button)).toBe(true);
  await userEvent.click(button);
  await expect.element(screen.getByRole("status")).toHaveTextContent(getMessages().workspace.copyFailed);
  await expect.element(page.elementLocator(document.querySelector(".pwa-copy-error")!)).toBeVisible();
  expect(document.querySelector(".pwa-copy-error")!.textContent).toBe(getMessages().workspace.copyFailed);
  expect(document.querySelector(".pwa-copy-error")!.getAttribute("aria-hidden")).toBe("true");
  expect(button.getAttribute("aria-label")).toBe("Copy fixture");
  expect(hasCheck(button)).toBe(false);
  expect(document.body.textContent).not.toContain("private exception details");
  expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(write).toHaveBeenCalledTimes(2);
  expect(notify).not.toHaveBeenCalled();
});

test("default missing Clipboard API reports recovery instead of pretending success", async () => {
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue(undefined as unknown as Clipboard);
  const { screen, button, notify } = await fixture();
  await userEvent.click(button);
  await expect.element(screen.getByRole("status")).toHaveTextContent(getMessages().workspace.copyFailed);
  expect(hasCheck(button)).toBe(false);
  expect(notify).not.toHaveBeenCalled();
});

test("explicit toast rejection never claims success or emits a local result", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("permission denied"));
  const { button, notify } = await fixture("toast");
  await commit(() => { button.click(); });
  expect(button.getAttribute("aria-label")).toBe("Copy fixture");
  expect(notify).not.toHaveBeenCalled();
  expect(document.querySelector('[role="status"]')).toBeNull();
});

test.each(["success", "error"] as const)("a newer request invalidates an older late %s", async (late) => {
  const first = pendingCopy();
  const second = pendingCopy();
  vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { screen, button, notify } = await fixture();
  await userEvent.click(button);
  await userEvent.click(button);
  if (late === "success") {
    await commit(() => { second.reject(new Error("latest failure")); });
    await commit(first.resolve);
    expect(hasCheck(button)).toBe(false);
    expect(screen.getByRole("status").element().textContent).toBe(getMessages().workspace.copyFailed);
  } else {
    await commit(second.resolve);
    await commit(() => { first.reject(new Error("stale failure")); });
    expect(hasCheck(button)).toBe(true);
    expect(screen.getByRole("status").element().textContent).toBe(getMessages().workspace.copied);
  }
  expect(notify).not.toHaveBeenCalled();
});

test.each(["text", "inline-to-toast", "toast-to-inline"] as const)("changing %s invalidates pending results", async (change) => {
  const pending = pendingCopy();
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValueOnce().mockReturnValueOnce(pending.promise);
  const controller = createOperationNotificationController();
  const notify = vi.spyOn(controller, "notify").mockImplementation(() => {});
  let replace!: () => void;
  function Harness() {
    const [replaced, setReplaced] = useState(false);
    replace = () => setReplaced(true);
    const feedback = change === "toast-to-inline" ? (replaced ? "inline" : "toast") : (replaced && change === "inline-to-toast" ? "toast" : "inline");
    return <PwaToastProvider value={controller}><CopyButton text={replaced && change === "text" ? "New fixture" : "First fixture"} label="Copy fixture" feedback={feedback} /></PwaToastProvider>;
  }
  const screen = await renderPwa(<Harness />);
  const button = screen.getByRole("button", { name: "Copy fixture", exact: true }).element() as HTMLButtonElement;
  await userEvent.click(button);
  if (change === "toast-to-inline") {
    await expect.poll(() => notify.mock.calls.length).toBe(1);
    notify.mockClear();
  } else {
    await expect.poll(() => hasCheck(button)).toBe(true);
  }
  await userEvent.click(button);
  await commit(replace);
  await commit(pending.resolve);
  expect(button.getAttribute("aria-label")).toBe("Copy fixture");
  expect(button.querySelector("[data-copied]")).toBeNull();
  expect(document.querySelector('[role="status"]')?.textContent ?? "").toBe("");
  expect(notify).not.toHaveBeenCalled();
});

test.each(["success", "error"] as const)("changing content clears a settled %s result immediately", async (result) => {
  const write = vi.spyOn(navigator.clipboard, "writeText");
  if (result === "success") write.mockResolvedValue();
  else write.mockRejectedValue(new Error("private failure"));
  let replace!: () => void;
  function Harness() {
    const [text, setText] = useState("Original fixture");
    replace = () => setText("New fixture");
    return <CopyButton text={text} label="Copy fixture" />;
  }
  const screen = await renderPwa(<Harness />);
  const button = screen.getByRole("button", { name: "Copy fixture", exact: true }).element() as HTMLButtonElement;
  await userEvent.click(button);
  await expect.element(screen.getByRole("status")).toHaveTextContent(result === "success" ? getMessages().workspace.copied : getMessages().workspace.copyFailed);
  await commit(replace);
  expect(hasCheck(button)).toBe(false);
  expect(screen.getByRole("status").element().textContent).toBe("");
  expect(document.querySelector(".pwa-copy-error")).toBeNull();
});

test.each(["toast", "inline"] as const)("late %s success cannot emit after unmount", async (feedback) => {
  const pending = pendingCopy();
  vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(pending.promise);
  const { screen, button, notify } = await fixture(feedback);
  await userEvent.click(button);
  await screen.unmount();
  await commit(pending.resolve);
  expect(notify).not.toHaveBeenCalled();
  expect(document.querySelector(".pwa-copy-error")).toBeNull();
  expect(document.querySelector('[role="status"]')).toBeNull();
});

test.each(["en", "zh"] as const)("%s local failure stays in a narrow viewport without moving controls or stealing focus", async (language) => {
  await page.viewport(320, 600);
  setLanguagePreference(language);
  const pending = pendingCopy();
  vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(pending.promise);
  const screen = await renderPwa(<div style={{ display: "flex", justifyContent: "flex-end", width: "100%" }}>
    <code style={{ flex: 1 }}>Original selectable text</code>
    <CopyButton text="Original selectable text" label="Copy fixture" />
    <button type="button">Close fixture</button>
  </div>);
  const button = screen.getByRole("button", { name: "Copy fixture", exact: true }).element() as HTMLButtonElement;
  const close = screen.getByRole("button", { name: "Close fixture", exact: true }).element() as HTMLButtonElement;
  const before = [geometry(button), geometry(close)];
  expect(button.parentElement).toBe(close.parentElement);
  await userEvent.click(button);
  close.focus();
  await commit(() => { pending.reject(new Error("private details")); });
  await expect.poll(() => document.querySelector(".pwa-copy-error")?.textContent).toBe(getMessages().workspace.copyFailed);
  const tooltip = document.querySelector<HTMLElement>(".pwa-copy-error")!;
  await expect.poll(() => {
    const rect = tooltip.getBoundingClientRect();
    return rect.width > 0 && Math.round(rect.left) >= 0 && Math.round(rect.right) <= window.innerWidth && Math.round(rect.top) >= 0 && Math.round(rect.bottom) <= window.innerHeight;
  }).toBe(true);
  expect(tooltip.closest(".pwa-root")).not.toBeNull();
  expect([geometry(button), geometry(close)]).toEqual(before);
  expect(tooltip.getAttribute("aria-hidden")).toBe("true");
  expect(button.getAttribute("aria-describedby")).toBeNull();
  expect(getComputedStyle(tooltip).pointerEvents).toBe("none");
  expect(document.querySelector("code")!.textContent).toBe("Original selectable text");
  expect(document.activeElement).toBe(close);
});

test("inline-text writes a visible result, keeps the button name and announces once", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const { screen, button, notify } = await fixture("inline-text");
  const row = button.closest(".pwa-copy-inline")!;
  const visible = row.querySelector(".pwa-copy-inline-status")!;
  expect(visible.getAttribute("aria-hidden")).toBe("true");
  expect(visible.textContent).toBe("");
  await userEvent.click(button);
  await expect.poll(() => visible.textContent).toBe(getMessages().workspace.copied);
  await expect.element(screen.getByRole("status")).toHaveTextContent(getMessages().workspace.copied);
  expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(button.getAttribute("aria-label")).toBe("Copy fixture");
  expect(row.querySelector(".pwa-copy-inline-icons")!.hasAttribute("data-copied")).toBe(true);
  expect(notify).not.toHaveBeenCalled();
});

test("inline-text failure stays as recovery advice and drops the check without a Toast", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("permission denied"));
  const { button, notify } = await fixture("inline-text");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await commit(() => { button.click(); });
  const row = button.closest(".pwa-copy-inline")!;
  const visible = row.querySelector(".pwa-copy-inline-status")!;
  expect(visible.textContent).toBe(getMessages().workspace.copyFailed);
  expect(visible.getAttribute("data-state")).toBe("error");
  expect(row.querySelector('[role="status"]')!.textContent).toBe(getMessages().workspace.copyFailed);
  expect(row.querySelector(".pwa-copy-inline-icons")!.hasAttribute("data-copied")).toBe(false);
  await commit(() => { vi.advanceTimersByTime(5000); });
  expect(visible.textContent).toBe(getMessages().workspace.copyFailed);
  expect(button.getAttribute("aria-label")).toBe("Copy fixture");
  expect(notify).not.toHaveBeenCalled();
});
