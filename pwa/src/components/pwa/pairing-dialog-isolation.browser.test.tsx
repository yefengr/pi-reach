import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { getMessages } from "@/lib/i18n";
import type { PairingErrorCode } from "@/lib/pwa/use-device-pairing";
import { PairingDialog } from "./pairing-dialog";

function Harness({ complete, submitted }: { complete: Promise<void>; submitted: (code: string) => void }) {
  const [opened, setOpened] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<PairingErrorCode | null>(null);
  const submit = async (code: string) => {
    submitted(code);
    setConnecting(true);
    await complete;
    setConnecting(false);
    setError("unknown_code");
  };
  return <>
    <button onClick={() => setOpened(true)}>Open isolated pairing</button>
    <PairingDialog codeOnly opened={opened} connecting={connecting} error={error} onSubmit={code => { void submit(code); }} onClearError={() => setError(null)} onClose={() => setOpened(false)} />
  </>;
}

afterEach(() => vi.restoreAllMocks());

test("codeOnly remains a code form on a camera-capable phone, including reopen, with no camera or file controls", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148");
  vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(5);
  const camera = vi.spyOn(navigator.mediaDevices, "getUserMedia");
  const submitted = vi.fn();
  const screen = await renderPwa(<Harness complete={Promise.resolve()} submitted={submitted} />);
  const trigger = screen.getByRole("button", { name: "Open isolated pairing" });
  for (let opening = 0; opening < 2; opening += 1) {
    trigger.element().focus();
    await trigger.click();
    await expect.element(screen.getByRole("textbox", { name: getMessages().pairing.codeLabel })).toBeVisible();
    expect(document.querySelector(".pwa-pairing-dialog video, .pwa-pairing-dialog input[type=file], .pwa-pairing-methods")).toBeNull();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector(".pwa-pairing-dialog")).toBeNull();
    await expect.element(trigger).toHaveFocus();
  }
  expect(camera).not.toHaveBeenCalled();
  expect(submitted).not.toHaveBeenCalled();
});

test("codeOnly preserves normalization, automatic submission, connecting and recoverable inline error", async () => {
  let finish!: () => void;
  const complete = new Promise<void>(resolve => { finish = resolve; });
  const submitted = vi.fn();
  const screen = await renderPwa(<Harness complete={complete} submitted={submitted} />);
  await screen.getByRole("button", { name: "Open isolated pairing" }).click();
  const input = screen.getByRole("textbox", { name: getMessages().pairing.codeLabel });
  await input.fill("k7mp-4q2d");
  expect(submitted).toHaveBeenCalledExactlyOnceWith("K7MP-4Q2D");
  await expect.element(input).toBeDisabled();
  await expect.element(screen.getByText(getMessages().pairing.connecting)).toBeVisible();
  finish();
  await expect.element(input).toBeEnabled();
  await expect.element(input).toHaveValue("K7MP-4Q2D");
  await expect.element(screen.getByText(getMessages().pairing.errors.unknown_code)).toBeVisible();
  await expect.element(input).toHaveFocus();
  await input.fill("K7MP");
  await expect.element(screen.getByText(getMessages().pairing.errors.unknown_code)).not.toBeInTheDocument();
});
