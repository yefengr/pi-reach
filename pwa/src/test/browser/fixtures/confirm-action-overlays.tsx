import { useRef, useState } from "react";
import { ConfirmActionDialog, type ConfirmActionDialogAction } from "@/components/pwa/confirm-action-dialog";
import { SessionSheet } from "@/components/pwa/session-sheet";
import { SettingsPage } from "@/components/pwa/settings-page";
import { canCloseBackgroundOverlay, pickConfirmationFocusFallback } from "@/components/pwa/pwa-confirm-actions";
import { displayDevice } from "@/components/pwa/workspace-view";
import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";

export function SettingsConfirmHarness() {
  const [confirmAction, setConfirmAction] = useState<ConfirmActionDialogAction | null>(null);
  const [confirmTransition, setConfirmTransition] = useState<"idle" | "opening" | "exited">("idle");
  const confirmOpenRef = useRef(false);

  const requestClear = () => {
    confirmOpenRef.current = true;
    setConfirmTransition("opening");
    setConfirmAction({ kind: "clear-local-data" });
  };
  return (
    <>
      <span data-testid="settings-confirm-transition" data-state={confirmTransition} hidden />
      <div className="pwa-settings-view"><SettingsPage relayUrl="https://relay.example.test" defaultRelayUrl="https://relay.default.test" onSave={async () => {}} onBack={() => {}} backLabel="Back to workspace" onClearData={requestClear} onResetLayout={() => {}} /></div>
      <ConfirmActionDialog
        action={confirmAction}
        pending={false}
        onConfirm={() => {}}
        onClose={() => setConfirmAction(null)}
        onExitTransitionEnd={() => { confirmOpenRef.current = false; setConfirmTransition("exited"); }}
      />
    </>
  );
}

const sessionDevice: PwaDeviceRecord = {
  id: "device:office",
  deviceId: "device-office-key",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  hostname: "office",
};
const sessionEndpoints: PwaEndpointRecord[] = [
  { id: "endpoint:current", deviceId: sessionDevice.deviceId, endpointId: "endpoint-current", runtimeInstanceId: "runtime-current", kind: "interactive", name: "Office Pi", cwd: "/work/pi-reach", online: true, updatedAt: 1 },
];

export function SessionConfirmHarness() {
  const [sheetOpen, setSheetOpen] = useState(true);
  const [devices, setDevices] = useState<PwaDeviceRecord[]>([sessionDevice]);
  const [confirmAction, setConfirmAction] = useState<ConfirmActionDialogAction | null>(null);
  const [confirmTransition, setConfirmTransition] = useState<"idle" | "opening" | "exited">("idle");
  const confirmOpenRef = useRef(false);
  const confirmFocusOriginRef = useRef<HTMLElement | null>(null);
  const confirmFallbackSelectors = [
    '.pwa-session-sheet button[aria-label="Close navigation"]',
    ".pwa-session-sheet .pwa-device-trigger",
    ".pwa-session-sheet .pwa-manage-computers",
    'button[aria-label="Open navigation"]',
  ];

  const requestRemove = (device: PwaDeviceRecord) => {
    confirmOpenRef.current = true;
    setConfirmTransition("opening");
    confirmFocusOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmAction({ kind: "remove-pairing", label: displayDevice(device) });
  };
  const closeSheet = () => {
    if (canCloseBackgroundOverlay(confirmOpenRef.current, false)) setSheetOpen(false);
  };
  const confirmRemove = () => {
    setDevices([]);
    setConfirmAction(null);
  };
  const restoreFocus = () => {
    const dialog = document.querySelector<HTMLElement>(".pwa-confirm-dialog");
    const candidates = [
      confirmFocusOriginRef.current,
      ...confirmFallbackSelectors.map((selector) => document.querySelector<HTMLElement>(selector)),
    ];
    const fallback = pickConfirmationFocusFallback(
      document.activeElement instanceof HTMLElement ? document.activeElement : null,
      candidates,
      (element: HTMLElement) => element !== document.body && element !== document.documentElement && !dialog?.contains(element),
      (element: HTMLElement) => element.isConnected && !element.matches(":disabled") && element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"]'),
    );
    fallback?.focus({ preventScroll: true });
    confirmOpenRef.current = false;
    confirmFocusOriginRef.current = null;
    setConfirmTransition("exited");
  };

  return (
    <>
      <span data-testid="session-confirm-transition" data-state={confirmTransition} hidden />
      <button type="button" aria-label="Open navigation" onClick={() => setSheetOpen(true)}>Open navigation</button>
      <SessionSheet devices={devices} endpoints={sessionEndpoints} history={[]} activeDeviceId={sessionDevice.id} activeEndpointId="endpoint-current" selectedHistoryId={null} snapshotReady pairingPresence={{ [sessionDevice.id]: { status: "online", onlineEndpoints: 1, totalEndpoints: 1 } }} onSettings={() => {}} onSelectDevice={() => {}} onSelectEndpoint={() => {}} onSelectHistory={() => {}} onPair={() => {}} onRename={() => {}} onRemove={requestRemove} onClose={closeSheet} opened={sheetOpen} />
      <ConfirmActionDialog action={confirmAction} pending={false} onConfirm={confirmRemove} onClose={() => setConfirmAction(null)} onExitTransitionEnd={restoreFocus} />
    </>
  );
}
