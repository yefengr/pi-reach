import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PAIR_WIDGET_KEY, PairingDisplay } from "./display.js";

const TTL_MS = 60_000;

function fakeUi() {
  return { notify: vi.fn(), setWidget: vi.fn() };
}

function invite(code: string) {
  return { code, expiresAt: Date.now() + TTL_MS };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PairingDisplay", () => {
  test("shows the QR, code, and expiry in the pairing widget", () => {
    const ui = fakeUi();

    new PairingDisplay().show(ui, invite("ABCD2345"));

    expect(ui.setWidget).toHaveBeenCalledWith(PAIR_WIDGET_KEY, expect.arrayContaining([
      "Scan to pair:",
      "Pairing code: ABCD2345",
      expect.stringContaining("Expires at:"),
    ]));
  });

  test("hides the QR once its code is paired and cancels the expiry notice", () => {
    const ui = fakeUi();
    const display = new PairingDisplay();
    display.show(ui, invite("ABCD2345"));

    display.paired("ABCD2345", "phone");
    vi.advanceTimersByTime(TTL_MS);

    expect(ui.setWidget).toHaveBeenLastCalledWith(PAIR_WIDGET_KEY, undefined);
    expect(ui.notify.mock.calls).toEqual([["[pi-reach] Paired: phone", "info"]]);
  });

  test("strips control characters from the Owner-supplied device name", () => {
    const ui = fakeUi();
    const display = new PairingDisplay();
    display.show(ui, invite("ABCD2345"));

    display.paired("ABCD2345", "\u001b[31mpho\u200bne\u0007");

    expect(ui.notify).toHaveBeenCalledWith("[pi-reach] Paired: [31mphone", "info");
  });

  test("falls back to a placeholder when nothing printable remains in the device name", () => {
    const ui = fakeUi();
    const display = new PairingDisplay();
    display.show(ui, invite("ABCD2345"));

    display.paired("ABCD2345", " \u0007\u200b ");

    expect(ui.notify).toHaveBeenCalledWith("[pi-reach] Paired: unnamed device", "info");
  });

  test("hides the QR and asks for a new code when it expires", () => {
    const ui = fakeUi();
    new PairingDisplay().show(ui, invite("ABCD2345"));

    vi.advanceTimersByTime(TTL_MS);

    expect(ui.setWidget).toHaveBeenLastCalledWith(PAIR_WIDGET_KEY, undefined);
    expect(ui.notify).toHaveBeenCalledWith("[pi-reach] Pairing code expired. Run /pi-reach pair again.", "info");
  });

  test("ignores a stale code after a newer QR replaces it", () => {
    const ui = fakeUi();
    const display = new PairingDisplay();
    display.show(ui, invite("ABCD2345"));
    vi.advanceTimersByTime(TTL_MS / 2);
    display.show(ui, invite("WXYZ6789"));
    ui.setWidget.mockClear();

    display.paired("ABCD2345", "phone");
    vi.advanceTimersByTime(TTL_MS / 2);

    expect(ui.setWidget).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  test("hide clears the QR silently and tolerates a stale UI context", () => {
    const ui = fakeUi();
    const display = new PairingDisplay();
    display.show(ui, invite("ABCD2345"));
    ui.setWidget.mockImplementation(() => { throw new Error("stale context"); });

    expect(() => display.hide()).not.toThrow();
    vi.advanceTimersByTime(TTL_MS);

    expect(ui.notify).not.toHaveBeenCalled();
  });
});
