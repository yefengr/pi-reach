import { useState } from "react";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { ActionIcon, Badge, Button, Radio, Select, Stack, Text, TextInput, Title } from "@mantine/core";
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

test.each([390, 767, 768, 1280].flatMap(width => ["light", "dark"].map(scheme => ({ width, scheme }))))("uses the enlarged typography scale for Mantine controls at $width in $scheme", async ({ width, scheme }) => {
  await page.viewport(width, 844);
  const originalScheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  const screen = await renderPwa(<>
    <Title order={1}>Page title</Title>
    <Title order={2}>Session title</Title>
    <Title order={3}>Section title</Title>
    <Text size="xs">Metadata</Text>
    <Text size="sm">List label</Text>
    <Text size="md">Body text</Text>
    <Text size="lg">Large text</Text>
    <Text size="xl">Page text</Text>
    <TextInput className="pwa-input" label="Computer name" description="Only saved in this browser" />
    <Button>Save typography</Button>
  </>);
  try {
    document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
    for (const [text, size] of [["Page title", "24px"], ["Session title", "18px"], ["Section title", "16px"], ["Metadata", "13px"], ["List label", "14px"], ["Body text", "16px"], ["Large text", "18px"], ["Page text", "24px"], ["Save typography", "16px"]]) {
      expect(getComputedStyle(screen.getByText(text, { exact: true }).element()).fontSize).toBe(size);
    }
    const input = screen.getByRole("textbox", { name: "Computer name" }).element();
    expect(getComputedStyle(input).fontSize).toBe("16px");
    expect(Math.round(input.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(getComputedStyle(document.querySelector(".mantine-InputWrapper-label")!).fontSize).toBe("14px");
    expect(getComputedStyle(screen.getByText("Only saved in this browser").element()).fontSize).toBe("13px");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  } finally {
    if (originalScheme === null) document.documentElement.removeAttribute("data-mantine-color-scheme");
    else document.documentElement.setAttribute("data-mantine-color-scheme", originalScheme);
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

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

/** 解析 token 的实际颜色，与元素计算样式比较时不依赖十六进制写法。 */
function resolvedColor(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.querySelector(".pwa-root")!.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

test("Mantine spacing follows the spacing tokens, including button icon sections", async () => {
  const screen = await renderPwa(<>
    {(["xs", "sm", "md", "lg", "xl"] as const).map(size => <Stack key={size} data-testid={`stack-${size}`} gap={size}><span>a</span><span>b</span></Stack>)}
    <Button leftSection={<span data-testid="icon-section">+</span>}>With icon</Button>
  </>);
  try {
    for (const [size, gap] of [["xs", "8px"], ["sm", "12px"], ["md", "16px"], ["lg", "24px"], ["xl", "32px"]] as const) {
      expect(getComputedStyle(screen.getByTestId(`stack-${size}`).element()).rowGap).toBe(gap);
    }
    const section = screen.getByTestId("icon-section").element().closest(".mantine-Button-section")!;
    const label = document.querySelector(".mantine-Button-label")!;
    expect(Math.round(label.getBoundingClientRect().left - section.getBoundingClientRect().right)).toBe(8);
  } finally { await screen.unmount(); }
});

test.each(["light", "dark"] as const)("form labels sit 8px above inputs and unchecked radios use the control outline in %s mode", async (scheme) => {
  const originalScheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  const screen = await renderPwa(<>
    <TextInput className="pwa-input" label="Relay URL" />
    <Radio.Group name="probe" value="a" className="pwa-appearance-options">
      <Radio className="pwa-appearance-option" value="a" label="Selected" />
      <Radio className="pwa-appearance-option" value="b" label="Unselected" />
    </Radio.Group>
  </>);
  try {
    document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
    const label = document.querySelector(".pwa-input .mantine-InputWrapper-label")!.getBoundingClientRect();
    const input = screen.getByRole("textbox", { name: "Relay URL" }).element().getBoundingClientRect();
    expect(Math.round(input.top - label.bottom)).toBe(8);
    const unchecked = screen.getByRole("radio", { name: "Unselected" }).element();
    // 切换外观后边框颜色有过渡，等过渡结束再比较。
    await expect.poll(() => getComputedStyle(unchecked).borderTopColor).toBe(resolvedColor("--pwa-control-line"));
  } finally {
    if (originalScheme === null) document.documentElement.removeAttribute("data-mantine-color-scheme");
    else document.documentElement.setAttribute("data-mantine-color-scheme", originalScheme);
    await screen.unmount();
  }
});
