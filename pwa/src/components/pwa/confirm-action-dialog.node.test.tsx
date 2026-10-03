import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement } from "react";
import { ConfirmActionDialog, type ConfirmActionDialogAction } from "./confirm-action-dialog";
import { canCloseBackgroundOverlay, pickConfirmationFocusFallback, runConfirmAction, type ConfirmActionRequest } from "./pwa-confirm-actions";
import { PwaUiProvider } from "./pwa-ui-provider";
import type { PwaDeviceRecord } from "@/lib/pwa/db";

function render(action: ConfirmActionDialogAction, pending = false): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <ConfirmActionDialog action={action} pending={pending} onConfirm={() => {}} onClose={() => {}} withinPortal={false} />
    </PwaUiProvider>,
  );
}

function buttonByClass(html: string, className: string): string {
  const match = html.match(new RegExp(`<button(?=[^>]*type="button")(?=[^>]*${className})[^>]*>[\\s\\S]*?<\\/button>`));
  expect(match, `expected one ${className} button`).toBeTruthy();
  return match![0];
}

function confirmButton(html: string): string {
  const match = html.match(/<button(?=[^>]*type="button")(?=[^>]*data-variant="(?:filled|outline)")[^>]*>[\s\S]*?<\/button>/);
  expect(match, "expected one confirmation button").toBeTruthy();
  return match![0];
}

test("keeps a closed modal mounted so Mantine can observe the opened transition", () => {
  // 组件使用语言 hook，须在渲染过程中调用才能取得其返回的元素。
  const captured: { element?: ReturnType<typeof ConfirmActionDialog> } = {};
  function Probe() {
    captured.element = ConfirmActionDialog({ action: null, pending: false, onConfirm: () => {}, onClose: () => {}, withinPortal: false });
    return null;
  }
  renderToStaticMarkup(<PwaUiProvider><Probe /></PwaUiProvider>);
  const closedDialog = captured.element;
  expect(isValidElement<{ opened: boolean }>(closedDialog)).toBe(true);
  expect((closedDialog as ReactElement<{ opened: boolean }>).props.opened).toBe(false);

  const html = renderToStaticMarkup(<PwaUiProvider>{closedDialog}</PwaUiProvider>);
  expect(html).not.toMatch(/role="dialog"/);
  expect(html).not.toMatch(/pwa-confirm-dialog/);

  const appSource = readFileSync(new URL("./pwa-app.tsx", import.meta.url), "utf8");
  expect(appSource).toMatch(/^\s*<ConfirmActionDialog action=/m);
  expect(appSource).not.toMatch(/\{confirmAction\s*\?\s*<ConfirmActionDialog/);
});

test("uses focus fallbacks only when Mantine cannot keep an active element", () => {
  const original = { id: "original", valid: false };
  const firstFallback = { id: "first", valid: true };
  const secondFallback = { id: "second", valid: true };
  const active = { id: "active", valid: true };
  const shouldKeepActive = (element: typeof active) => element.valid;
  const canFocus = (element: typeof active) => element.valid;

  expect(pickConfirmationFocusFallback(active, [original, firstFallback], shouldKeepActive, canFocus)).toBe(null);
  expect(pickConfirmationFocusFallback(null, [original, firstFallback, secondFallback], shouldKeepActive, canFocus)).toBe(firstFallback);
  expect(pickConfirmationFocusFallback(null, [original, null], shouldKeepActive, canFocus)).toBe(null);
});

test("keeps background drawers open while a confirmation is active", () => {
  expect(canCloseBackgroundOverlay(true, false)).toBe(false);
  expect(canCloseBackgroundOverlay(false, true)).toBe(false);
  expect(canCloseBackgroundOverlay(false, false)).toBe(true);
});

test("renders each confirmation action as an accessible Mantine modal", () => {
  const cases: Array<{ action: ConfirmActionDialogAction; title: string; description: string; confirmLabel: string }> = [
    { action: { kind: "new-session" }, title: "Start a fresh session?", description: "Everyone viewing this Pi will move to a fresh conversation.", confirmLabel: "Start fresh session" },
    { action: { kind: "remove-pairing", label: "office" }, title: "Delete pairing for office?", description: "This removes this computer pairing, saved Pi details, and local history from this browser.", confirmLabel: "Delete pairing" },
    { action: { kind: "clear-local-data" }, title: "Clear this browser&#x27;s Pi Reach identity, pairings, and history?", description: "This cannot be undone. It removes this browser&#x27;s Pi Reach identity, pairings, and history.", confirmLabel: "Clear local data" },
  ];

  for (const scenario of cases) {
    const html = render(scenario.action);
    expect(html).toMatch(/mantine-Modal-content/);
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toMatch(/aria-labelledby="pwa-confirm-action-title"/);
    expect(html).toMatch(/aria-describedby="pwa-confirm-action-description"/);
    expect(html).toMatch(new RegExp(scenario.title.replace(/[?]/g, "\\?")));
    expect(html).toMatch(new RegExp(scenario.description.replace(/[?]/g, "\\?")));
    expect(buttonByClass(html, "pwa-button")).toMatch(/Cancel/);
    expect(confirmButton(html)).toMatch(new RegExp(scenario.confirmLabel));
    expect(html).toMatch(/aria-label="Close confirmation dialog"/);
    expect(html).toMatch(/title="Close confirmation dialog"/);
    expect(html).toMatch(/type="button"/);
  }
});

test("renders attachment leave copy and invokes navigation only after confirmation", async () => {
  const html = render({ kind: "leave-attachments" });
  expect(html).toContain("Stop sending attachments?");
  expect(html).toContain("Keep sending");
  expect(html).toContain("Stop and switch");
  expect(html).toContain("draft stays with the original Pi");
  const harness = actionHarness();
  let navigation = 0;
  const action = { kind: "leave-attachments" as const, next: () => { navigation++; } };
  expect(navigation).toBe(0);
  expect(await runConfirmAction(action, harness.effects, harness.state)).toBe("completed");
  expect(navigation).toBe(1);
  expect(harness.successes()).toBe(1);
});

test("uses a primary confirmation for a new session and a solid danger confirmation for destructive actions", () => {
  const newSessionConfirm = confirmButton(render({ kind: "new-session" }));
  expect(newSessionConfirm).toMatch(/data-variant="filled"/);
  expect(newSessionConfirm).not.toMatch(/data-variant="outline"/);

  for (const action of [{ kind: "remove-pairing", label: "office" } as const, { kind: "clear-local-data" } as const]) {
    const html = render(action);
    const matches = html.match(/<button(?=[^>]*type="button")(?=[^>]*pwa-danger-confirm)[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(matches.length).toBe(1);
    expect(matches[0]).toMatch(/data-variant="filled"/);
    expect(html).not.toMatch(/data-variant="outline"/);
  }
});

test("locks all close paths while an action is pending", () => {
  const html = render({ kind: "clear-local-data" }, true);
  const pendingConfirm = confirmButton(html);
  expect(pendingConfirm).toMatch(/disabled=""/);
  expect(pendingConfirm).toMatch(/Clearing local data…/);
  expect(buttonByClass(html, "pwa-button")).toMatch(/disabled=""/);
  expect(buttonByClass(html, "pwa-button")).toMatch(/Cancel/);
  expect(html).toMatch(/aria-label="Close confirmation dialog"[^>]*disabled=""/);
});

const device: PwaDeviceRecord = {
  id: "device:main",
  deviceId: "device-main",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  hostname: "office",
};

function actionHarness(overrides: Partial<{
  startNewSession: () => boolean;
  removePairing: (target: PwaDeviceRecord) => Promise<void>;
  invalidateConnection: () => void;
  clearLocalData: () => Promise<void>;
  reload: () => void;
}> = {}) {
  const pendingRef = { current: false };
  const pending: boolean[] = [];
  const errors: Array<string | null> = [];
  let successes = 0;
  return {
    pendingRef,
    pending,
    errors,
    successes: () => successes,
    effects: {
      startNewSession: () => true,
      removePairing: async () => {},
      invalidateConnection: () => {},
      clearLocalData: async () => {},
      reload: () => {},
      ...overrides,
    },
    state: {
      pendingRef,
      setPending: (value: boolean) => pending.push(value),
      setError: (value: string | null) => errors.push(value),
      onSuccess: () => { successes += 1; },
    },
  };
}

test("runs a remove-pairing confirmation once while concurrent confirms are locked", async () => {
  let releaseRemoval = () => {};
  const removal = new Promise<void>((resolve) => { releaseRemoval = resolve; });
  let removals = 0;
  const harness = actionHarness({ removePairing: async () => { removals += 1; await removal; } });
  const action: ConfirmActionRequest = { kind: "remove-pairing", label: "Pi on office / interactive", device };

  const first = runConfirmAction(action, harness.effects, harness.state);
  const second = await runConfirmAction(action, harness.effects, harness.state);
  releaseRemoval();

  expect(second).toBe("ignored");
  expect(await first).toBe("completed");
  expect(removals).toBe(1);
  expect(harness.successes()).toBe(1);
  expect(harness.pending).toStrictEqual([true, false]);
  expect(harness.errors).toStrictEqual([null]);
  expect(harness.pendingRef.current).toBe(false);
});

test("keeps the confirmation open with an error when starting a session is rejected", async () => {
  const harness = actionHarness({ startNewSession: () => false });

  const result = await runConfirmAction({ kind: "new-session" }, harness.effects, harness.state);

  expect(result).toBe("failed");
  expect(harness.successes()).toBe(0);
  expect(harness.pending).toStrictEqual([true, false]);
  expect(harness.errors).toStrictEqual([null, "Could not start a fresh session. Check the connection and try again."]);
});

test("keeps a failed remove confirmation available for retry", async () => {
  const harness = actionHarness({ removePairing: async () => { throw new Error("IndexedDB endpoint_id=550e8400-e29b-41d4-a716-446655440000"); } });

  const result = await runConfirmAction({ kind: "remove-pairing", label: "Pi on office / interactive", device }, harness.effects, harness.state);

  expect(result).toBe("failed");
  expect(harness.successes()).toBe(0);
  expect(harness.errors).toStrictEqual([null, "Could not delete pairing. Try again."]);
  expect(harness.pendingRef.current).toBe(false);
});

test("keeps clear-data failure inside the dialog without raw exception text", async () => {
  const harness = actionHarness({ clearLocalData: async () => { throw new Error("DOMException: database inaccessible"); } });
  expect(await runConfirmAction({ kind: "clear-local-data" }, harness.effects, harness.state)).toBe("failed");
  expect(harness.errors).toStrictEqual([null, "Could not clear local data. Try again."]);
  expect(harness.pendingRef.current).toBe(false);
});

test("invalidates, clears, and reloads local data in order", async () => {
  const effects: string[] = [];
  const harness = actionHarness({
    invalidateConnection: () => effects.push("invalidate"),
    clearLocalData: async () => { effects.push("clear"); },
    reload: () => effects.push("reload"),
  });

  const result = await runConfirmAction({ kind: "clear-local-data" }, harness.effects, harness.state);

  expect(result).toBe("completed");
  expect(effects).toStrictEqual(["invalidate", "clear", "reload"]);
  expect(harness.successes()).toBe(0);
  expect(harness.pending).toStrictEqual([true, false]);
});
