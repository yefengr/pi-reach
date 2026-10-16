import { expect, test } from "vitest";
import { isPrimaryModifier, shortcutLabel, workspaceShortcut } from "./keyboard-shortcuts";

function keyEvent(key: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key, metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, defaultPrevented: false,
    isComposing: false, repeat: false, keyCode: 0, getModifierState: () => false, ...overrides } as KeyboardEvent;
}

test("uses only the platform primary modifier and known workspace bindings", () => {
  expect(workspaceShortcut(keyEvent("\\"), false)).toBe("toggleSidebar");
  expect(workspaceShortcut(keyEvent(","), false)).toBe("openSettings");
  expect(workspaceShortcut(keyEvent("/"), false)).toBe("showHelp");
  expect(workspaceShortcut(keyEvent("/", { metaKey: true, ctrlKey: false }), true)).toBe("showHelp");
  expect(workspaceShortcut(keyEvent("b"), false)).toBeNull();
  expect(workspaceShortcut(keyEvent("/"), true)).toBeNull();
  expect(isPrimaryModifier({ metaKey: true, ctrlKey: false }, false)).toBe(false);
});

test.each([
  { shiftKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: false },
  { isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true },
  { getModifierState: (name: string) => name === "AltGraph" },
])("does not consume typing, repeats, extra modifiers or handled events: %j", (overrides) => {
  expect(workspaceShortcut(keyEvent("/", overrides), false)).toBeNull();
});

test("derives displayed keys from the bindings, platform and send preference", () => {
  expect(shortcutLabel("toggleSidebar", true, true)).toBe("⌘ + \\");
  expect(shortcutLabel("openSettings", true, false)).toBe("Ctrl + ,");
  expect(shortcutLabel("showHelp", true, false)).toBe("Ctrl + /");
  expect(shortcutLabel("send", true, true)).toBe("Enter");
  expect(shortcutLabel("send", false, true)).toBe("⌘ + Enter");
  expect(shortcutLabel("sendAlternative", true, false)).toBe("Ctrl + Enter");
  expect(shortcutLabel("newline", true, false)).toBe("Shift + Enter");
  expect(shortcutLabel("newline", false, false)).toBe("Enter");
  expect(shortcutLabel("closeOverlay", true, false)).toBe("Escape");
});
