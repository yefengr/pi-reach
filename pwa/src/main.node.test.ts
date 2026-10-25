import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({ normal: vi.fn(), diagnostic: vi.fn(), render: vi.fn(), textSize: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: calls.render }) }));
vi.mock("./components/pwa/pwa-app-entry", () => ({ PwaAppEntry: calls.normal }));
vi.mock("./diagnostics/keyboard-diagnostics-page", () => ({ KeyboardDiagnosticsPage: calls.diagnostic }));
vi.mock("@/lib/ui/text-size", () => ({ applyStoredTextSize: calls.textSize, shouldRestoreTextSize: () => true }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
test("production diagnostics dispatch precedes and isolates the lazy business entry", () => {
  expect(source).not.toMatch(/^import .*\b(?:PwaApp|PwaAppShell|ServiceWorkerRegister)\b/m);
  expect(source).toContain('window.location.pathname === "/app/keyboard-diagnostics"');
  expect(source.indexOf('import("./diagnostics/keyboard-diagnostics-page")')).toBeLessThan(source.indexOf('import("./components/pwa/pwa-app-entry")'));
  expect(source).toMatch(/if \(diagnostics\)[\s\S]*else if/);
  expect(source).toContain("!diagnostics && shouldRestoreTextSize(reviewPath)");
});

test.each(["/app/keyboard-diagnostics", "/app", "/app/settings"])("bootstrap only loads the selected entry at %s", async pathname => {
  vi.resetModules();
  vi.stubGlobal("document", { getElementById: () => ({}) });
  vi.stubGlobal("window", { location: { pathname } });
  await import("./main");
  await vi.waitFor(() => expect(calls.render).toHaveBeenCalledTimes(1));
  expect(calls.render.mock.calls[0]![0].props.children.type).toBe(pathname === "/app/keyboard-diagnostics" ? calls.diagnostic : calls.normal);
  expect(calls.textSize.mock.calls.length).toBe(pathname === "/app/keyboard-diagnostics" ? 0 : 1);
});
