import { useCallback, useRef } from "react";
import type { PwaDeviceRecord } from "@/lib/pwa/db";
import { safeConfirmationError } from "@/lib/pwa/feedback-messages";

export type ConfirmActionRequest =
  | { kind: "new-session" }
  | { kind: "remove-pairing"; label: string; device: PwaDeviceRecord }
  | { kind: "clear-local-data" }
  | { kind: "leave-attachments"; next: () => void; uploads?: boolean; files?: boolean };

type ConfirmActionEffects = {
  startNewSession: () => boolean;
  removePairing: (device: PwaDeviceRecord) => Promise<void>;
  invalidateConnection: () => void;
  clearLocalData: () => Promise<void>;
  reload: () => void;
};
type ConfirmActionState = {
  pendingRef: { current: boolean };
  setPending: (pending: boolean) => void;
  setError: (error: string | null) => void;
  onSuccess: () => void;
};

export async function runConfirmAction(action: ConfirmActionRequest, effects: ConfirmActionEffects, state: ConfirmActionState): Promise<"completed" | "failed" | "ignored"> {
  if (state.pendingRef.current) return "ignored";
  state.pendingRef.current = true;
  state.setPending(true);
  state.setError(null);
  try {
    if (action.kind === "leave-attachments") {
      action.next();
      state.onSuccess();
    } else if (action.kind === "new-session") {
      if (!effects.startNewSession()) throw new Error("Could not start a fresh session. Check the connection and try again.");
      state.onSuccess();
    } else if (action.kind === "remove-pairing") {
      await effects.removePairing(action.device);
      state.onSuccess();
    } else {
      effects.invalidateConnection();
      await effects.clearLocalData();
      effects.reload();
    }
    return "completed";
  } catch {
    state.setError(action.kind === "leave-attachments" ? "Could not complete this action. Try again." : safeConfirmationError(action.kind));
    return "failed";
  } finally {
    state.pendingRef.current = false;
    state.setPending(false);
  }
}

export function pickConfirmationFocusFallback<T>(activeElement: T | null, candidates: readonly (T | null)[], shouldKeepActive: (element: T) => boolean, canFocus: (element: T) => boolean): T | null {
  if (activeElement !== null && shouldKeepActive(activeElement)) return null;
  return candidates.find((candidate): candidate is T => candidate !== null && canFocus(candidate)) ?? null;
}

export function canCloseBackgroundOverlay(confirmOpen: boolean, confirmPending: boolean): boolean {
  return !confirmOpen && !confirmPending;
}

export function focusedElement(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body && active !== document.documentElement ? active : null;
}

function canFocus(element: HTMLElement): boolean {
  return element.isConnected && !element.matches(":disabled") && element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"]');
}

export function useConfirmationOverlay(
  setAction: (action: ConfirmActionRequest | null) => void,
  setError: (error: string | null) => void,
  pendingRef: { current: boolean },
) {
  const focusOriginRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(false);
  const requestConfirmation = useCallback((action: ConfirmActionRequest) => {
    focusOriginRef.current = focusedElement();
    openRef.current = true;
    setError(null);
    setAction(action);
  }, [setAction, setError]);
  const closeBackgroundOverlay = useCallback((close: () => void) => {
    if (canCloseBackgroundOverlay(openRef.current, pendingRef.current)) close();
  }, [pendingRef]);
  const finishConfirmationTransition = useCallback(() => {
    const dialog = document.querySelector<HTMLElement>(".pwa-confirm-dialog");
    const fallback = pickConfirmationFocusFallback(
      focusedElement(),
      [
        focusOriginRef.current,
        document.querySelector<HTMLElement>(".pwa-session-sheet .pwa-navigation-close"),
        document.querySelector<HTMLElement>(".pwa-sidebar .pwa-nav-settings"),
        document.querySelector<HTMLElement>(".pwa-session-trigger"),
      ],
      (element) => canFocus(element) && !dialog?.contains(element),
      canFocus,
    );
    fallback?.focus({ preventScroll: true });
    focusOriginRef.current = null;
    openRef.current = false;
  }, []);
  return { requestConfirmation, closeBackgroundOverlay, finishConfirmationTransition };
}
