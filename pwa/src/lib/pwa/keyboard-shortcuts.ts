import { useLocalStorage } from "@mantine/hooks";

export const DESKTOP_KEYBOARD_QUERY = "(min-width: 768px)";
export const ENTER_SENDS_STORAGE_KEY = "pi-reach-enter-sends";

export function useEnterSends() {
  return useLocalStorage<boolean>({
    key: ENTER_SENDS_STORAGE_KEY,
    defaultValue: true,
    getInitialValueInEffect: false,
    // 本地设置不是可信输入；未知值恢复默认，不把字符串 "false" 当成真值。
    deserialize: (value) => value !== "false",
  });
}

export const WORKSPACE_SHORTCUTS = {
  toggleSidebar: "\\",
  openSettings: ",",
  showHelp: "/",
} as const;
export type WorkspaceShortcut = keyof typeof WORKSPACE_SHORTCUTS;
export type ShortcutAction = WorkspaceShortcut | "send" | "sendAlternative" | "newline" | "closeOverlay";

export function isAppleKeyboard(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function isPrimaryModifier(event: Pick<KeyboardEvent, "metaKey" | "ctrlKey">, apple = isAppleKeyboard()): boolean {
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function ignoreShortcutEvent(event: KeyboardEvent): boolean {
  return event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat
    || event.getModifierState("AltGraph");
}

export function workspaceShortcut(event: KeyboardEvent, apple = isAppleKeyboard()): WorkspaceShortcut | null {
  if (ignoreShortcutEvent(event) || event.altKey || event.shiftKey || !isPrimaryModifier(event, apple)) return null;
  return (Object.keys(WORKSPACE_SHORTCUTS) as WorkspaceShortcut[])
    .find((action) => WORKSPACE_SHORTCUTS[action] === event.key) ?? null;
}

export function shortcutLabel(action: ShortcutAction, enterSends = true, apple = isAppleKeyboard()): string {
  const mod = apple ? "⌘" : "Ctrl";
  if (action === "send") return enterSends ? "Enter" : `${mod} + Enter`;
  if (action === "sendAlternative") return `${mod} + Enter`;
  if (action === "newline") return enterSends ? "Shift + Enter" : "Enter";
  if (action === "closeOverlay") return "Escape";
  return `${mod} + ${WORKSPACE_SHORTCUTS[action]}`;
}

export function isKeyboardInput(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'));
}

/** 与既有叠层门禁一致：退出且已 inert/aria-hidden 的旧节点不再阻断。 */
export function hasKeyboardOverlay(root: ParentNode = document): boolean {
  return [...root.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')].some((overlay) =>
    overlay.isConnected
    && !overlay.closest('[inert], [aria-hidden="true"]')
    && overlay.getClientRects().length > 0
    && getComputedStyle(overlay).visibility !== "hidden",
  );
}
