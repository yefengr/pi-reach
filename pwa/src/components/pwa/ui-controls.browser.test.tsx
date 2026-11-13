import { useState } from "react";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { ActionIcon, Badge, Button, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { DesktopSidebar, WorkspaceHistorySection } from "./workspace-view";
import { ChoosePiWorkspace, UnpairedWorkspace } from "./workspace-content";
import { StartupErrorView } from "./pwa-startup";
import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";
import type { TimelineSessionSummary } from "@/lib/pwa/timeline-store";
import { minimumControlHeight } from "@/test/browser/button-height";

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

test("the desktop empty navigation pairing action keeps the regular button height", async () => {
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
  // 常规按钮：纯细指针 36，存在粗指针时 44（DESIGN「按钮尺寸」）。
  expect(rect.height).toBeGreaterThanOrEqual(minimumControlHeight(pairing.element()));
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
      expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(minimumControlHeight(button));
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

test.each(["light", "dark"] as const)("form labels sit 8px above inputs in %s mode", async (scheme) => {
  const originalScheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  const screen = await renderPwa(<>
    <TextInput className="pwa-input" label="Relay URL" />
  </>);
  try {
    document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
    const label = document.querySelector(".pwa-input .mantine-InputWrapper-label")!.getBoundingClientRect();
    const input = screen.getByRole("textbox", { name: "Relay URL" }).element().getBoundingClientRect();
    expect(Math.round(input.top - label.bottom)).toBe(8);
  } finally {
    if (originalScheme === null) document.documentElement.removeAttribute("data-mantine-color-scheme");
    else document.documentElement.setAttribute("data-mantine-color-scheme", originalScheme);
    await screen.unmount();
  }
});

const gap = (upper: Element, lower: Element) => Math.round(lower.getBoundingClientRect().top - upper.getBoundingClientRect().bottom);
const onlineEndpoint = (id: string): PwaEndpointRecord => ({ id: `endpoint:${id}`, deviceId: "device", endpointId: id, runtimeInstanceId: id, kind: "interactive", name: `Pi ${id}`, cwd: "/repo/pi-reach", online: true, updatedAt: 1 });

test("empty states space icon, title, description and the next block by one layout layer", async () => {
  await page.viewport(1280, 900);
  let screen = await renderPwa(<div className="pwa-main"><UnpairedWorkspace onPair={() => {}} /></div>);
  const state = document.querySelector(".pwa-workspace-state")!;
  expect(getComputedStyle(state).rowGap).toBe("0px");
  const [icon, title, description, block, action] = [".pwa-workspace-state-icon", "h2", "p", ".pwa-command-block", ".pwa-button"].map(selector => state.querySelector(selector)!);
  expect([gap(icon, title), gap(title, description), gap(description, block), gap(block, action)]).toEqual([16, 8, 16, 16]);
  await screen.unmount();
  screen = await renderPwa(<div className="pwa-main"><ChoosePiWorkspace endpoints={[onlineEndpoint("a"), onlineEndpoint("b")]} onSelect={() => {}} /></div>);
  expect(gap(document.querySelector(".pwa-choose-pi h2")!, document.querySelector(".pwa-choose-pi-list")!)).toBe(16);
  await screen.unmount();
});

test("navigation row text shares the 16px left edge of the brand and section headings", async () => {
  await page.viewport(1280, 720);
  const screen = await renderPwa(<DesktopSidebar devices={[{ id: "device:a", deviceId: "device", relayUrl: "https://relay.example.test", pairedAt: "2026-01-01T00:00:00.000Z", hostname: "office" }]} endpoints={[onlineEndpoint("a")]} history={[]} activeDeviceId="device:a" activeEndpointId={null} selectedHistoryId={null} snapshotReady onPair={() => {}} onSettings={() => {}} onSelectDevice={() => {}} onSelectEndpoint={() => {}} onSelectHistory={() => {}} onRename={() => {}} onRemove={() => {}} />);
  try {
    const sidebar = document.querySelector(".pwa-sidebar")!.getBoundingClientRect();
    const heading = document.querySelector(".pwa-nav-section-heading")!;
    const label = document.querySelector(".pwa-nav-session .mantine-NavLink-label")!.getBoundingClientRect();
    expect(Math.round(label.left - sidebar.left)).toBe(16);
    // 分组标题以 16 的图标开头，图标盒左缘即内容左缘。
    expect(Math.round(heading.firstElementChild!.getBoundingClientRect().left - sidebar.left)).toBe(16);
  } finally { await screen.unmount(); }
});

test("background history loading keeps existing rows in place", async () => {
  const device: PwaDeviceRecord = { id: "device:a", deviceId: "device", relayUrl: "https://relay.example.test", pairedAt: "2026-01-01T00:00:00.000Z" };
  const history: TimelineSessionSummary[] = [{ id: "history:a", deviceId: "device", endpointId: "old", sessionId: "saved", leafId: null, startedAt: 1, updatedAt: 2, eventCount: 1, preview: "Saved record" }];
  function Harness() {
    const [loading, setLoading] = useState(false);
    return <><button onClick={() => setLoading(true)}>Refresh</button><WorkspaceHistorySection activeDevice={device} history={history} selectedHistoryId={null} historyListStatus={loading ? "loading" : "success"} onSelectHistory={() => {}} headingId="history-heading" /></>;
  }
  const screen = await renderPwa(<Harness />);
  try {
    const row = document.querySelector<HTMLElement>(".pwa-history-row")!;
    const top = Math.round(row.getBoundingClientRect().top);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(document.querySelector(".pwa-history-row")).toBe(row);
    expect(Math.round(row.getBoundingClientRect().top)).toBe(top);
    expect(document.querySelector(".pwa-nav-empty-status")).toBeNull();
  } finally { await screen.unmount(); }
});

test("disabled command rows use secondary text instead of transparency", async () => {
  const screen = await renderPwa(<div className="pwa-command-menu-panel">
    <button type="button" className="pwa-command-row" disabled><span className="pwa-command-copy"><code>/compact</code><small>Compact context</small></span></button>
  </div>);
  try {
    const row = document.querySelector(".pwa-command-row")!;
    expect(getComputedStyle(row).opacity).toBe("1");
    expect(getComputedStyle(row.querySelector("code")!).color).toBe(resolvedColor("--pwa-secondary"));
  } finally { await screen.unmount(); }
});

test("startup notices keep icons on the 16/20/24 scale and the mobile gutter", async () => {
  await page.viewport(390, 844);
  const screen = await renderPwa(<StartupErrorView error={null} onRetry={() => {}} />);
  const icon = document.querySelector(".pwa-startup-icon")!.getBoundingClientRect();
  expect([Math.round(icon.width), Math.round(icon.height)]).toEqual([48, 48]);
  const card = document.querySelector<HTMLElement>(".pwa-startup-card")!;
  expect(getComputedStyle(card).paddingLeft).toBe("16px");
  // 嵌入式卡片：bg 上的 card 底、圆角 16、不描边（DESIGN「卡片」）。
  const fill = document.createElement("span");
  fill.style.backgroundColor = "var(--pwa-card)";
  card.append(fill);
  expect([getComputedStyle(card).borderTopWidth, getComputedStyle(card).borderRadius, getComputedStyle(card).backgroundColor]).toEqual(["0px", "16px", getComputedStyle(fill).backgroundColor]);
  fill.remove();
  // 大号标题引出的独立说明与主区空状态同为 8。
  const title = document.querySelector(".pwa-startup-card h1")!.getBoundingClientRect();
  const description = document.querySelector(".pwa-startup-card h1 + p")!.getBoundingClientRect();
  expect(Math.round(description.top - title.bottom)).toBe(8);
  await screen.unmount();
  await page.viewport(1280, 900);
});

test("the mobile file reader keeps its last content above the bottom safe area", async () => {
  await page.viewport(390, 844);
  document.documentElement.style.setProperty("--pwa-safe-bottom", "34px");
  const screen = await renderPwa(<div className="pwa-file-reader-scroll">Content</div>);
  try {
    expect(getComputedStyle(document.querySelector(".pwa-file-reader-scroll")!).paddingBottom).toBe("34px");
  } finally {
    document.documentElement.style.removeProperty("--pwa-safe-bottom");
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});
