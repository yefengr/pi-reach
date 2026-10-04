import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Menu } from "@mantine/core";
import type { WireModel } from "@/lib/pi-reach/types";
import {
  ComposerCommandMenuPanel,
  ComposerModelSettingsMenuPanel,
  type ComposerCommandMenuPanelProps,
  type ComposerModelSettingsMenuPanelProps,
} from "./composer-command-menu";
import { PwaUiProvider } from "./pwa-ui-provider";

const model: WireModel = {
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  provider: "anthropic",
  reasoning: true,
  context_window: 200000,
  vision: true,
};

const sessionProps: ComposerCommandMenuPanelProps = {
  isOnline: true,
  isWorking: false,
  pendingAction: null,
  onNewSession: () => {},
  onCompactSession: () => {},
};

const settingsProps: Omit<ComposerModelSettingsMenuPanelProps, "view"> = {
  isOnline: true,
  pendingAction: null,
  models: [model],
  currentModel: model,
  currentModelFallback: null,
  thinking: "medium",
  onSetModel: () => {},
  onSetThinking: () => {},
  onBack: () => {},
  onOpenModels: () => {},
  onOpenThinking: () => {},
};

function renderSession(overrides: Partial<ComposerCommandMenuPanelProps> = {}): string {
  return renderToStaticMarkup(<PwaUiProvider><Menu><ComposerCommandMenuPanel {...sessionProps} {...overrides} /></Menu></PwaUiProvider>);
}

function renderSettings(view: ComposerModelSettingsMenuPanelProps["view"], overrides: Partial<ComposerModelSettingsMenuPanelProps> = {}): string {
  return renderToStaticMarkup(<PwaUiProvider><Menu><ComposerModelSettingsMenuPanel {...settingsProps} {...overrides} view={view} /></Menu></PwaUiProvider>);
}

test("renders only the new and compact Pi commands in the slash menu", () => {
  const html = renderSession();

  expect(html.match(/data-menu-item="true"/g)).toHaveLength(2);
  expect(html).toMatch(/mantine-Menu-item/);
  expect(html).toMatch(/\/new/);
  expect(html).toMatch(/New session/);
  expect(html).toMatch(/\/compact/);
  expect(html).toMatch(/Compact context/);
  expect(html).not.toMatch(/\/model/);
  expect(html).not.toMatch(/\/thinking/);
  expect(html).not.toMatch(/Change model/);
  expect(html).not.toMatch(/Thinking level/);
});

test("disables both slash commands while working, offline or when another action is pending", () => {
  for (const override of [{ isWorking: true }, { isOnline: false }, { pendingAction: "model_set" as const }]) {
    const html = renderSession(override);
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
  }
});

test("renders the settings root with only the model and thinking entries", () => {
  const html = renderSettings("settings");

  expect(html).toMatch(/role="group" aria-label="Model and thinking"/);
  expect(html.match(/data-menu-item="true"/g)).toHaveLength(2);
  expect(html).toMatch(/>Change model</);
  expect(html).toMatch(/>Thinking level</);
  expect(html).not.toMatch(/\/new/);
  expect(html).not.toMatch(/\/compact/);
});

test("shows the endpoint fallback and the explicit unavailable state in the settings root", () => {
  const fallback = renderSettings("settings", { currentModel: null, currentModelFallback: "GPT-5.4" });
  expect(fallback).toMatch(/GPT-5.4/);
  expect(fallback).not.toMatch(/Current model unavailable/);

  const unavailable = renderSettings("settings", { currentModel: null, currentModelFallback: null });
  expect(unavailable).toMatch(/Current model unavailable/);
});

test("disables every settings entry offline or when another action is pending", () => {
  for (const override of [{ pendingAction: "model_set" as const }, { isOnline: false }]) {
    const html = renderSettings("settings", override);
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
  }
});

test("renders the model chooser with provider, name, and current model", () => {
  const html = renderSettings("models");

  expect(html).toMatch(/role="group" aria-label="Change model"/);
  expect(html).toMatch(/role="menuitem"/);
  expect(html).toMatch(/Back/);
  expect(html).toMatch(/Change model/);
  expect(html).toMatch(/anthropic \/ Claude Sonnet 4/);
  expect(html).toMatch(/aria-label="Current model"/);
});

test("renders every thinking level and marks the active level", () => {
  const html = renderSettings("thinking");

  expect(html).toMatch(/role="group" aria-label="Thinking level"/);
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) expect(html).toMatch(new RegExp(`>${level}<`));
  expect(html).toMatch(/aria-label="Current thinking level"/);
});

test("keeps Back enabled when model and thinking choices are pending", () => {
  for (const view of ["models", "thinking"] as const) {
    const html = renderSettings(view, { pendingAction: "model_set" });
    expect(html).toMatch(/mantine-Menu-label/);
    expect((html.match(/disabled=""/g) ?? []).length).toBe(view === "models" ? 1 : 6);
    const back = html.match(/<button\b[^>]*>[\s\S]*?Back[\s\S]*?<\/button>/)?.[0];
    expect(back).toBeDefined();
    expect(back).not.toMatch(/disabled=""/);
  }
});

test("keeps an empty model catalog readable with a Back action", () => {
  const html = renderSettings("models", { models: [] });
  expect(html).toContain("No models available.");
  expect(html.match(/role="menuitem"/g)).toHaveLength(1);
  expect(html).toContain("Back");
});
