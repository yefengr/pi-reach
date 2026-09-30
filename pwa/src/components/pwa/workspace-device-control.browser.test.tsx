import { useEffect, useRef, useState } from "react";
import { beforeEach, expect, test } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { WorkspaceDeviceControl, type WorkspaceDeviceControlVariant } from "./workspace-device-control";
import { renderPwa } from "@/test/browser/render";
import type { PwaDeviceRecord } from "@/lib/pwa/db";

const currentDevice: PwaDeviceRecord = {
  id: "device:current",
  deviceId: "current-device-public-key",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  nickname: "Current computer with an intentionally very long local name",
};
const nextDevice: PwaDeviceRecord = {
  id: "device:next",
  deviceId: "next-device-public-key",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-02T00:00:00.000Z",
  nickname: "Travel Mac",
};

function DeviceControlHarness({ variant, purpose = "choose", events }: { variant: WorkspaceDeviceControlVariant; purpose?: "choose" | "manage"; events: string[] }) {
  const [target, setTarget] = useState<string | null>(null);
  const targetRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { targetRef.current?.focus(); }, [target]);
  const finish = (event: string) => { events.push(event); setTarget(event); };
  return <div style={{ width: 286 }}>
    <WorkspaceDeviceControl
      devices={[currentDevice, nextDevice]}
      activeDeviceId={currentDevice.id}
      pairingPresence={{
        [currentDevice.id]: { status: "online", onlineEndpoints: 2, totalEndpoints: 2 },
        [nextDevice.id]: { status: "offline", onlineEndpoints: 0, totalEndpoints: 1 },
      }}
      onPair={() => finish("pair")}
      onSelectDevice={(deviceId) => finish(`select:${deviceId}`)}
      onRename={(device) => finish(`rename:${device.id}`)}
      onRemove={(device) => finish(`remove:${device.id}`)}
      variant={variant}
      purpose={purpose}
    />
    {target ? <button ref={targetRef} type="button" data-testid="device-action-target">{target}</button> : null}
  </div>;
}

beforeEach(async () => { await page.viewport(1280, 800); });

test("desktop chooser uses a portal Popover, truncates long names, and finishes selection without stealing focus", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<DeviceControlHarness variant="desktop" events={events} />);
  const trigger = screen.getByRole("button", { name: /Choose computer, current Current computer/ });
  await trigger.click();
  const panel = document.querySelector<HTMLElement>(".pwa-device-popover")!;
  expect(panel).not.toBeNull();
  expect(panel.closest(".pwa-root")).not.toBeNull();
  expect(Number(getComputedStyle(panel).zIndex)).toBe(220);
  const current = screen.getByRole("button", { name: /Current computer with an intentionally very long local name ONLINE/ });
  const label = current.element().querySelector<HTMLElement>(".pwa-peer-label")!;
  expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
  expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
  expect(current.element().textContent).toContain("Current");
  expect(current.element().textContent).toContain("2 Pis running");
  for (const summary of panel.querySelectorAll<HTMLElement>(".pwa-peer-summary")) {
    expect(summary.scrollWidth, summary.textContent ?? "").toBeLessThanOrEqual(summary.clientWidth);
  }
  await screen.getByRole("button", { name: /Travel Mac OFFLINE/ }).click();
  await expect.poll(() => events).toEqual(["select:device:next"]);
  await expect.element(screen.getByTestId("device-action-target")).toHaveFocus();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await expect.element(screen.getByTestId("device-action-target")).toHaveFocus();
});

test("desktop management panel routes rename, remove, and pair after it closes", async () => {
  const events: string[] = [];
  const screen = await renderPwa(<DeviceControlHarness variant="desktop" purpose="manage" events={events} />);
  const trigger = screen.getByRole("button", { name: "Computers" });

  await trigger.click();
  await screen.getByRole("button", { name: "Computer actions for Travel Mac" }).click();
  await screen.getByRole("menuitem", { name: "Rename Travel Mac" }).click();
  await expect.poll(() => events).toEqual(["rename:device:next"]);
  await expect.element(screen.getByTestId("device-action-target")).toHaveFocus();

  await trigger.click();
  await screen.getByRole("button", { name: "Computer actions for Travel Mac" }).click();
  await screen.getByRole("menuitem", { name: "Remove Travel Mac" }).click();
  await expect.poll(() => events.slice(-1)).toEqual(["remove:device:next"]);

  await trigger.click();
  await screen.getByRole("button", { name: "Pair a computer" }).click();
  await expect.poll(() => events.slice(-1)).toEqual(["pair"]);
});

test("reduced motion fades the computer Drawer without movement and returns focus after Escape", async () => {
  await page.viewport(390, 700);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const events: string[] = [];
  const screen = await renderPwa(<DeviceControlHarness variant="sheet" events={events} />);
  try {
    const trigger = screen.getByRole("button", { name: /Choose computer, current Current computer/ });
    trigger.element().focus();
    await trigger.click();
    const dialog = screen.getByRole("dialog", { name: "Choose computer" });
    await expect.element(dialog).toBeVisible();
    const drawer = dialog.element();
    await expect.poll(() => getComputedStyle(drawer).transitionDuration).toBe("0.12s");
    expect(getComputedStyle(drawer).transitionProperty.split(",").map((name) => name.trim())).toContain("opacity");
    expect(getComputedStyle(drawer).transform).toBe("none");
    const overlay = document.querySelector<HTMLElement>(".mantine-Drawer-overlay")!;
    await expect.poll(() => getComputedStyle(overlay).transitionDuration).toBe("0.12s");
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
    expect(events).toEqual([]);

    await trigger.click();
    await screen.getByRole("button", { name: /Travel Mac OFFLINE/ }).click();
    await expect.poll(() => events).toEqual(["select:device:next"]);
    await expect.element(screen.getByTestId("device-action-target")).toHaveFocus();
  } finally {
    await screen.unmount();
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  }
});

test("mobile chooser is a compact z220 bottom Drawer with reachable actions and stable Escape focus", async () => {
  await page.viewport(320, 568);
  const events: string[] = [];
  const screen = await renderPwa(<DeviceControlHarness variant="sheet" events={events} />);
  const trigger = screen.getByRole("button", { name: /Choose computer, current Current computer/ });
  trigger.element().focus();
  await trigger.click();
  const dialog = screen.getByRole("dialog", { name: "Choose computer" });
  await expect.element(dialog).toBeVisible();
  const root = dialog.element().closest<HTMLElement>(".mantine-Drawer-root")!;
  expect(root.closest(".pwa-root")).not.toBeNull();
  expect(getComputedStyle(root).getPropertyValue("--mb-z-index")).toBe("220");
  await expect.poll(() => Math.round(dialog.element().getBoundingClientRect().bottom)).toBe(window.innerHeight);
  const rect = dialog.element().getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(rect.height).toBeLessThan(320);
  for (const action of [
    screen.getByRole("button", { name: /Travel Mac OFFLINE/ }),
    screen.getByRole("button", { name: "Computer actions for Travel Mac" }),
    screen.getByRole("button", { name: "Pair a computer" }),
    screen.getByRole("button", { name: "Close computer chooser" }),
  ]) {
    const box = action.element().getBoundingClientRect();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await page.screenshot({ path: "../../../.vitest/screenshots/workspace-device-control-320x568.png" });
  await screen.getByRole("button", { name: "Computer actions for Travel Mac" }).click();
  await expect.element(screen.getByRole("menu")).toBeVisible();
  await userEvent.keyboard("{Escape}{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
  expect(events).toEqual([]);
});
