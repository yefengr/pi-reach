import { useEffect, useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { getPwaDatabase, makePwaDeviceId, openPwaDatabase, type PwaDeviceRecord, type PwaEndpointRecord } from "@/lib/pwa/db";
import {
  ACTIVE_DEVICE_SETTING,
  activeEndpointSettingKey,
  useActiveEndpointSelection,
  type ActiveEndpointSelection,
} from "./use-active-endpoint-selection";

const firstDevice: PwaDeviceRecord = { id: makePwaDeviceId("first-device"), deviceId: "first-device", relayUrl: "https://relay.example.test", pairedAt: "2026-09-01T00:00:00.000Z", hostname: "first-host" };
const secondDevice: PwaDeviceRecord = { id: makePwaDeviceId("second-device"), deviceId: "second-device", relayUrl: "https://relay.example.test", pairedAt: "2026-09-02T00:00:00.000Z", hostname: "second-host" };
function endpoint(endpointId: string, device = firstDevice): PwaEndpointRecord {
  return { id: `${device.deviceId}:${endpointId}`, deviceId: device.deviceId, endpointId, runtimeInstanceId: `runtime-${endpointId}`, kind: "interactive", online: true, updatedAt: 1 };
}

type SelectionHarness = {
  selection: ActiveEndpointSelection;
  setDevices: (devices: PwaDeviceRecord[]) => void;
  setEndpoints: (endpoints: PwaEndpointRecord[]) => void;
  setSnapshotDeviceIds: (ids: string[]) => void;
  setPaused: (paused: boolean) => void;
};

function SelectionHarnessView({ onController, onDeviceSelected, onPreferenceSaveError }: { onController: (controller: SelectionHarness) => void; onDeviceSelected: () => void; onPreferenceSaveError: () => void }) {
  const [devices, setDevices] = useState<PwaDeviceRecord[]>([firstDevice, secondDevice]);
  const [endpoints, setEndpoints] = useState<PwaEndpointRecord[]>([]);
  const [snapshotDeviceIds, setSnapshotDeviceIds] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const selection = useActiveEndpointSelection({ devices, endpoints, snapshotDeviceIds, automaticSelectionPaused: paused, onDeviceSelected, onPreferenceSaveError });

  useEffect(() => { onController({ selection, setDevices, setEndpoints, setSnapshotDeviceIds, setPaused }); }, [onController, selection]);
  return <output data-testid="selection">{`${selection.activeDeviceId ?? "none"}:${selection.activeEndpointId ?? "none"}:${selection.activeEndpointOrigin ?? "none"}`}</output>;
}

async function renderSelection() {
  let current: SelectionHarness | null = null;
  const onDeviceSelected = vi.fn();
  const onPreferenceSaveError = vi.fn();
  const screen = await renderPwa(<SelectionHarnessView onController={(controller) => { current = controller; }} onDeviceSelected={onDeviceSelected} onPreferenceSaveError={onPreferenceSaveError} />);
  await vi.waitFor(() => expect(current).not.toBeNull());
  return { screen, onDeviceSelected, onPreferenceSaveError, controller: () => {
    if (!current) throw new Error("Selection hook did not mount.");
    return current;
  } };
}

beforeEach(async () => {
  const database = await openPwaDatabase();
  await database.transaction("rw", [database.identities, database.devices, database.endpoints, database.events, database.settings], async () => {
    await Promise.all([database.identities.clear(), database.devices.clear(), database.endpoints.clear(), database.events.clear(), database.settings.clear()]);
  });
});

test("restores the validated startup computer and saves it", async () => {
  const { controller, screen } = await renderSelection();
  controller().selection.restoreActiveDevice(firstDevice.id);
  await vi.waitFor(() => expect(controller().selection.activeDevice).toEqual(firstDevice));
  await vi.waitFor(async () => expect((await getPwaDatabase().settings.get(ACTIVE_DEVICE_SETTING))?.value).toBe(firstDevice.id));
  await screen.unmount();
});

test("keeps a valid restored user choice when multiple Pis are online", async () => {
  await getPwaDatabase().settings.put({ key: activeEndpointSettingKey(firstDevice.id), value: "chosen" });
  const { controller, screen } = await renderSelection();
  controller().setEndpoints([endpoint("chosen"), endpoint("other")]);
  controller().setSnapshotDeviceIds([firstDevice.deviceId]);
  controller().selection.restoreActiveDevice(firstDevice.id);
  await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("chosen"));
  expect(controller().selection.activeEndpointOrigin).toBe("restored");
  await screen.unmount();
});

test("waits for the authoritative snapshot before automatically selecting the only online Pi", async () => {
  const { controller, screen } = await renderSelection();
  controller().selection.restoreActiveDevice(firstDevice.id);
  controller().setEndpoints([endpoint("only")]);
  await vi.waitFor(() => expect(controller().selection.activeDeviceId).toBe(firstDevice.id));
  expect(controller().selection.activeEndpointId).toBeNull();
  controller().setSnapshotDeviceIds([firstDevice.deviceId]);
  await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("only"));
  expect(controller().selection.activeEndpointOrigin).toBe("automatic");
  expect(await getPwaDatabase().settings.get(activeEndpointSettingKey(firstDevice.id))).toBeUndefined();
  await screen.unmount();
});

test("clears an automatic choice when multiple Pis are online", async () => {
  const { controller, screen } = await renderSelection();
  controller().selection.restoreActiveDevice(firstDevice.id);
  controller().setEndpoints([endpoint("first")]);
  controller().setSnapshotDeviceIds([firstDevice.deviceId]);
  await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("first"));
  controller().setEndpoints([endpoint("first"), endpoint("second")]);
  await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBeNull());
  await screen.unmount();
});

test("clears the live choice when no Pi remains online", async () => {
  const { controller, screen } = await renderSelection();
  controller().setEndpoints([endpoint("selected")]);
  controller().setSnapshotDeviceIds([firstDevice.deviceId]);
  controller().selection.restoreActiveDevice(firstDevice.id);
  await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("selected"));
  controller().setEndpoints([]);
  await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBeNull());
  await screen.unmount();
});

test("does not jump to a live Pi while history reading pauses automatic selection", async () => {
  const { controller, screen } = await renderSelection();
  controller().setPaused(true);
  controller().setEndpoints([endpoint("only")]);
  controller().setSnapshotDeviceIds([firstDevice.deviceId]);
  controller().selection.restoreActiveDevice(firstDevice.id);
  await vi.waitFor(() => expect(controller().selection.activeDeviceId).toBe(firstDevice.id));
  expect(controller().selection.activeEndpointId).toBeNull();
  controller().setPaused(false);
  await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("only"));
  await screen.unmount();
});

test("persists explicit Pi choices only for the active computer", async () => {
  const { controller, screen } = await renderSelection();
  controller().setEndpoints([endpoint("selected")]);
  controller().selection.restoreActiveDevice(firstDevice.id);
  await vi.waitFor(() => expect(controller().selection.activeDeviceId).toBe(firstDevice.id));
  controller().selection.selectEndpoint("selected");
  await vi.waitFor(async () => expect((await getPwaDatabase().settings.get(activeEndpointSettingKey(firstDevice.id)))?.value).toBe("selected"));
  expect(controller().selection.activeEndpointOrigin).toBe("manual");
  await screen.unmount();
});

test("keeps the live endpoint choice when preference persistence fails", async () => {
  const { controller, onPreferenceSaveError, screen } = await renderSelection();
  controller().setEndpoints([endpoint("selected")]);
  controller().setSnapshotDeviceIds([firstDevice.deviceId]);
  controller().selection.restoreActiveDevice(firstDevice.id);
  await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("selected"));
  const settings = getPwaDatabase().settings;
  const put = vi.spyOn(settings, "put").mockRejectedValueOnce(new Error("indexeddb unavailable"));
  controller().selection.selectEndpoint("selected");
  await vi.waitFor(() => expect(onPreferenceSaveError).toHaveBeenCalledOnce());
  expect(controller().selection.activeEndpointId).toBe("selected");
  put.mockRestore();
  await screen.unmount();
});
test("restores a saved manual Pi after temporary offline state", async () => {
  await getPwaDatabase().settings.put({ key: activeEndpointSettingKey(firstDevice.id), value: "chosen" });
  const { controller, screen } = await renderSelection();
  controller().setEndpoints([endpoint("chosen"), endpoint("other")]);
  controller().setSnapshotDeviceIds([firstDevice.deviceId]);
  controller().selection.restoreActiveDevice(firstDevice.id);
  await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("chosen"));

  controller().setEndpoints([]);
  await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBeNull());

  controller().setEndpoints([endpoint("chosen"), endpoint("other")]);
  await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("chosen"));
  expect(controller().selection.activeEndpointOrigin).toBe("restored");
  await screen.unmount();
});

test("clears an invalid active-computer setting", async () => {
  const { controller, screen } = await renderSelection();
  controller().selection.restoreActiveDevice(firstDevice.id);
  await vi.waitFor(async () => expect((await getPwaDatabase().settings.get(ACTIVE_DEVICE_SETTING))?.value).toBe(firstDevice.id));

  controller().selection.restoreActiveDevice(null);
  await vi.waitFor(async () => expect(await getPwaDatabase().settings.get(ACTIVE_DEVICE_SETTING)).toBeUndefined());
  await screen.unmount();
});

test("selecting the current computer exits history without discarding its Pi choice", async () => {
  const { controller, onDeviceSelected, screen } = await renderSelection();
  controller().setEndpoints([endpoint("selected")]);
  controller().setSnapshotDeviceIds([firstDevice.deviceId]);
  controller().selection.restoreActiveDevice(firstDevice.id);
  await vi.waitFor(() => expect(controller().selection.activeEndpointId).toBe("selected"));

  controller().selection.selectDevice(firstDevice.id);

  expect(onDeviceSelected).toHaveBeenCalledOnce();
  expect(controller().selection.activeEndpointId).toBe("selected");
  await screen.unmount();
});

test("manual computer selection resets consumers", async () => {
  const { controller, onDeviceSelected, screen } = await renderSelection();
  controller().selection.selectDevice(secondDevice.id);
  expect(onDeviceSelected).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(controller().selection.activeDeviceId).toBe(secondDevice.id));
  await screen.unmount();
});
