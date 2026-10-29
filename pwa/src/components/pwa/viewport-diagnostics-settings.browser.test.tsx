import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { flushSync } from "react-dom";
import { renderPwa } from "@/test/browser/render";
import { viewportDiagnosticCapture, recordViewportDiagnostic } from "@/lib/pwa/timeline-viewport-diagnostics";
import { ViewportDiagnosticsSettings } from "./viewport-diagnostics-settings";
import { getMessages, setLanguagePreference } from "@/lib/i18n";

function finishCapture() {
  for (let index = 0; index < 256; index++) recordViewportDiagnostic({ following: true, paused: false, unread: 0,
    generation: 1, mode: "send", reason: index === 0 ? "send" : "frame", top: 0, bottom: 20, requested: 20, actual: 20,
    effectiveTarget: 20, callbackTime: index, motionTime: index });
}
afterEach(async () => { viewportDiagnosticCapture.clear(); vi.useRealTimers(); vi.restoreAllMocks(); await page.viewport(1280, 900); });

test("diagnostic settings are gated offline and preparation does not navigate or sample before send", async () => {
  setLanguagePreference("en");
  const offline = await renderPwa(<ViewportDiagnosticsSettings online={false} />);
  await expect.element(offline.getByRole("button", { name: "Prepare next send" })).toBeDisabled();
  await offline.unmount();
  const screen = await renderPwa(<ViewportDiagnosticsSettings online />);
  const href = location.href;
  await screen.getByRole("button", { name: "Prepare next send" }).click();
  expect(viewportDiagnosticCapture.getSnapshot().phase).toBe("armed");
  expect(location.href).toBe(href);
  expect(screen.getByRole("textbox", { name: "Diagnostic JSON", exact: true }).query()).toBeNull();
  await screen.getByRole("button", { name: "Cancel capture" }).click();
  expect(viewportDiagnosticCapture.getSnapshot().phase).toBe("cancelled");
  await screen.getByRole("button", { name: "Clear capture" }).click();
  expect(viewportDiagnosticCapture.getSnapshot().phase).toBe("off");
  await screen.unmount();
});

test("download URLs retain their bounded consumption window through clear and unmount", async () => {
  setLanguagePreference("en");
  const screen = await renderPwa(<ViewportDiagnosticsSettings online />);
  let unmounted = false;
  try {
    await screen.getByRole("button", { name: "Prepare next send" }).click();
    finishCapture();
    await expect.element(screen.getByRole("button", { name: "Save diagnostic JSON" })).toBeVisible();
    const save = screen.getByRole("button", { name: "Save diagnostic JSON" }).element() as HTMLButtonElement;
    const clear = screen.getByRole("button", { name: "Clear capture" }).element() as HTMLButtonElement;
    let next = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:diagnostic-${++next}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.useFakeTimers();
    save.click();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke.mock.calls).toEqual([["blob:diagnostic-1"]]);
    save.click(); save.click();
    expect(vi.getTimerCount()).toBe(2);
    flushSync(() => clear.click());
    expect(revoke.mock.calls).toEqual([["blob:diagnostic-1"]]);
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(revoke.mock.calls).toEqual([["blob:diagnostic-1"], ["blob:diagnostic-2"], ["blob:diagnostic-3"]]);
    expect(vi.getTimerCount()).toBe(0);
    flushSync(() => viewportDiagnosticCapture.arm({ appVersion: "0.0.31", entryResource: null, standalone: true,
      displayMode: "standalone", dpr: 3, reducedMotion: false }));
    flushSync(finishCapture);
    (screen.getByRole("button", { name: "Save diagnostic JSON" }).element() as HTMLButtonElement).click();
    expect(vi.getTimerCount()).toBe(1);
    await screen.unmount(); unmounted = true;
    expect(revoke).not.toHaveBeenCalledWith("blob:diagnostic-4");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenLastCalledWith("blob:diagnostic-4");
    expect(vi.getTimerCount()).toBe(0);
    // mock click 只验证本地资源边界，不证明真实下载成功。
  } finally { vi.useRealTimers(); if (!unmounted) await screen.unmount(); }
});

test("synthetic completed diagnostic report stays reachable with 44px actions at 390px", async () => {
  setLanguagePreference("zh");
  await page.viewport(390, 844);
  const screen = await renderPwa(<div className="pwa-settings-view"><div className="pwa-settings-page"><div className="pwa-settings-inner">
    <p>合成诊断数据，仅用于局部布局验收</p><ViewportDiagnosticsSettings online />
  </div></div></div>);
  try {
    await screen.getByRole("button", { name: "准备下一次发送" }).click();
    finishCapture();
    const json = screen.getByRole("textbox", { name: "诊断 JSON", exact: true });
    await expect.element(json).toBeVisible();
    // 使用正式复制反馈，不能借用只在评审页加载的 inline-text 样式。
    const copyIcons = screen.getByRole("button", { name: "复制诊断 JSON", exact: true }).element().querySelectorAll("svg");
    expect(copyIcons).toHaveLength(2);
    expect([...copyIcons].filter((icon) => getComputedStyle(icon).opacity === "1")).toHaveLength(1);
    for (const name of ["准备下一次发送", "清除诊断", "复制诊断 JSON", "保存诊断 JSON"]) {
      const rect = screen.getByRole("button", { name, exact: true }).element().getBoundingClientRect();
      expect(Math.round(rect.height)).toBeGreaterThanOrEqual(44);
      expect(Math.round(rect.width)).toBeGreaterThanOrEqual(44);
      expect(Math.round(rect.left)).toBeGreaterThanOrEqual(0);
      expect(Math.round(rect.right)).toBeLessThanOrEqual(390);
    }
    await page.screenshot({ path: "../../../.vitest/screenshots/viewport-diagnostics-synthetic-mobile-top.png" });
    json.element().scrollIntoView({ block: "end" });
    await expect.element(json).toBeVisible();
    await page.screenshot({ path: "../../../.vitest/screenshots/viewport-diagnostics-synthetic-mobile-report.png" });
  } finally { await screen.unmount(); }
});

test("completed JSON supports clipboard success/failure, local download URL release and clear", async () => {
  setLanguagePreference("en");
  const screen = await renderPwa(<ViewportDiagnosticsSettings online />);
  await screen.getByRole("button", { name: "Prepare next send" }).click();
  finishCapture();
  const json = screen.getByRole("textbox", { name: "Diagnostic JSON", exact: true });
  await expect.element(json).toBeVisible();
  const value = (json.element() as HTMLTextAreaElement).value;
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await screen.getByRole("button", { name: "Copy diagnostic JSON" }).click();
  await expect.poll(() => copy.mock.calls).toEqual([[value]]);
  copy.mockRejectedValueOnce(new Error("unavailable"));
  await screen.getByRole("button", { name: "Copy diagnostic JSON" }).click();
  await expect.poll(() => document.body.textContent).toContain(getMessages().workspace.copyFailed);
  await expect.element(json).toHaveValue(value);
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:diagnostic-test");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await screen.getByRole("button", { name: "Save diagnostic JSON" }).click();
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect(click).toHaveBeenCalledOnce();
  expect(revoke).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Clear capture" }).click();
  await expect.poll(() => revoke.mock.calls, { timeout: 5000 }).toEqual([["blob:diagnostic-test"]]);
  expect(json.query()).toBeNull();
  await screen.unmount();
});
