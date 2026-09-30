import { useState } from "react";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { ActionIcon, Badge, Button, Select } from "@mantine/core";
import { DesktopSidebar } from "./workspace-view";

function SelectHarness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("endpoint-main");
  return (
    <Select
      className="pwa-select"
      aria-label="Endpoint"
      value={value}
      disabled={disabled}
      data={[
        { value: "endpoint-main", label: "Main endpoint" },
        { value: "endpoint-review", label: "Review endpoint" },
      ]}
      onChange={(next) => { if (next) setValue(next); }}
      comboboxProps={{ withinPortal: false }}
    />
  );
}

function PrimitiveHarness() {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 8, maxWidth: "100%" }}>
    <Button>Primary</Button>
    <Button variant="default">Secondary</Button>
    <Button variant="outline" color="red">Danger</Button>
    <Button variant="transparent" color="piReach">Text</Button>
    <ActionIcon aria-label="Default icon"><span aria-hidden="true">+</span></ActionIcon>
    <ActionIcon variant="filled" color="piReach" aria-label="Primary icon"><span aria-hidden="true">+</span></ActionIcon>
    <ActionIcon aria-label="Disabled icon" disabled><span aria-hidden="true">+</span></ActionIcon>
    <Badge className="pwa-presence-label online">ONLINE</Badge>
    <Badge className="pwa-current-label">Current</Badge>
  </div>;
}

test("Select opens with the keyboard and selects an option", async () => {
  const screen = await renderPwa(<SelectHarness />);
  const select = screen.getByRole("combobox", { name: "Endpoint" });

  select.element().focus();
  await userEvent.keyboard("{ArrowDown}");
  const review = screen.getByRole("option", { name: "Review endpoint" });
  await expect.element(review).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect.element(select).toHaveValue("Review endpoint");
});

test("disabled Select does not open", async () => {
  const screen = await renderPwa(<SelectHarness disabled />);
  const select = screen.getByRole("combobox", { name: "Endpoint" });

  await expect.element(select).toBeDisabled();
  select.element().focus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(screen.getByRole("option", { name: "Review endpoint" })).not.toBeInTheDocument();
});

test("Select remains within a 390 by 844 viewport", async () => {
  await page.viewport(390, 844);
  const screen = await renderPwa(<SelectHarness />);
  const select = screen.getByRole("combobox", { name: "Endpoint" });
  const rect = select.element().getBoundingClientRect();

  expect(rect.width).toBeGreaterThan(0);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(rect.height).toBeGreaterThanOrEqual(44);
});

test("the desktop empty navigation pairing action retains a 44px touch target", async () => {
  await page.viewport(1280, 720);
  const screen = await renderPwa(
    <DesktopSidebar
      devices={[]}
      endpoints={[]}
      history={[]}
      activeDeviceId={null}
      activeEndpointId={null}
      selectedHistoryId={null}
      snapshotReady
      onPair={() => {}}
      onSettings={() => {}}
      onSelectDevice={() => {}}
      onSelectEndpoint={() => {}}
      onSelectHistory={() => {}}
      onRename={() => {}}
      onRemove={() => {}}
    />,
  );
  const pairing = screen.getByRole("button", { name: "Pair a computer" });
  await expect.element(pairing).toBeVisible();
  const rect = pairing.element().getBoundingClientRect();
  expect(rect.width).toBeGreaterThanOrEqual(44);
  expect(rect.height).toBeGreaterThanOrEqual(44);
});

test.each(["light", "dark"] as const)("direct Mantine controls preserve variants, state labels, and touch targets in %s mode", async (scheme) => {
  await page.viewport(390, 844);
  const originalScheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  const screen = await renderPwa(<PrimitiveHarness />);
  try {
    document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
    const controls = [
      ["Primary", "filled"],
      ["Secondary", "default"],
      ["Danger", "outline"],
      ["Text", "transparent"],
    ] as const;
    for (const [name, variant] of controls) {
      const button = screen.getByRole("button", { name, exact: true }).element();
      expect(button).toHaveClass("pwa-button");
      expect(button).toHaveAttribute("data-variant", variant);
      expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    for (const name of ["Default icon", "Primary icon", "Disabled icon"]) {
      const icon = screen.getByRole("button", { name }).element();
      expect(icon).toHaveClass("pwa-icon-button");
      expect(icon.getBoundingClientRect().width).toBeCloseTo(44, 0);
      expect(icon.getBoundingClientRect().height).toBeCloseTo(44, 0);
    }
    await expect.element(screen.getByRole("button", { name: "Disabled icon" })).toBeDisabled();
    await expect.element(screen.getByText("ONLINE", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Current", { exact: true })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  } finally {
    if (originalScheme === null) document.documentElement.removeAttribute("data-mantine-color-scheme");
    else document.documentElement.setAttribute("data-mantine-color-scheme", originalScheme);
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});
