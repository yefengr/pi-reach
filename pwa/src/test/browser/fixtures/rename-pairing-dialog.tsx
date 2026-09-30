import { useState } from "react";
import { RenamePairingDialog } from "@/components/pwa/rename-pairing-dialog";
import { SessionSheet } from "@/components/pwa/session-sheet";
import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";

export const renameDevice: PwaDeviceRecord = {
  id: "device:office",
  deviceId: "device-office-key",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-01-01T00:00:00.000Z",
  hostname: "office",
};

const renameEndpoints: PwaEndpointRecord[] = [
  { id: "endpoint:current", deviceId: renameDevice.deviceId, endpointId: "endpoint-current", runtimeInstanceId: "runtime-current", kind: "interactive", name: "Office Pi", cwd: "/work/pi-reach", online: true, updatedAt: 1 },
];

type RenameRequest = {
  device: PwaDeviceRecord;
  focusOrigin: HTMLElement | null;
};

export function SessionRenameHarness({ onSave = async () => {} }: { onSave?: (nickname: string) => Promise<void> }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [renameRequest, setRenameRequest] = useState<RenameRequest | null>(null);

  const openRename = (device: PwaDeviceRecord) => {
    setRenameRequest({
      device,
      focusOrigin: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
    setSheetOpen(false);
  };

  return (
    <>
      <button type="button" aria-label="Open endpoint switcher" onClick={() => setSheetOpen(true)}>
        Endpoint switcher
      </button>
      {sheetOpen ? <SessionSheet devices={[renameDevice]} endpoints={renameEndpoints} history={[]} activeDeviceId={renameDevice.id} activeEndpointId="endpoint-current" selectedHistoryId={null} snapshotReady pairingPresence={{ [renameDevice.id]: { status: "online", onlineEndpoints: 1, totalEndpoints: 1 } }} onSettings={() => {}} onSelectDevice={() => {}} onSelectEndpoint={() => {}} onSelectHistory={() => {}} onPair={() => {}} onRename={openRename} onRemove={() => {}} onClose={() => setSheetOpen(false)} /> : null}
      {renameRequest ? <RenamePairingDialog device={renameRequest.device} onSave={onSave} onClose={() => setRenameRequest(null)} focusOrigin={renameRequest.focusOrigin} focusFallbackSelectors={['button[aria-label="Open endpoint switcher"]']} /> : null}
    </>
  );
}
