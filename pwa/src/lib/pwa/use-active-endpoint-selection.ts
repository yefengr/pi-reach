import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPwaDatabase, type PwaDeviceRecord, type PwaEndpointRecord } from "@/lib/pwa/db";

export const ACTIVE_DEVICE_SETTING = "active_device";
export const ACTIVE_ENDPOINT_SETTING_PREFIX = "active_endpoint:";

export function activeEndpointSettingKey(deviceId: string): string {
  return `${ACTIVE_ENDPOINT_SETTING_PREFIX}${deviceId}`;
}

export type EndpointSelectionOrigin = "manual" | "restored" | "automatic" | null;
type SavedEndpointSelectionOrigin = Exclude<EndpointSelectionOrigin, "automatic" | null>;
type EndpointPreference = {
  deviceRecordId: string | null;
  endpointId: string | null;
  origin: SavedEndpointSelectionOrigin | null;
  loaded: boolean;
};

export type ActiveEndpointSelection = {
  activeDeviceId: string | null;
  activeEndpointId: string | null;
  activeEndpointOrigin: EndpointSelectionOrigin;
  activeDevice: PwaDeviceRecord | null;
  selectDevice: (deviceId: string | null) => void;
  selectEndpoint: (endpointId: string) => void;
  restoreActiveDevice: (deviceId: string | null) => void;
  activatePairedDevice: (deviceId: string, endpointId: string) => void;
  isActiveDevice: (deviceId: string) => boolean;
};

type UseActiveEndpointSelectionOptions = {
  devices: readonly PwaDeviceRecord[];
  endpoints: readonly PwaEndpointRecord[];
  snapshotDeviceIds: readonly string[];
  automaticSelectionPaused: boolean;
  onDeviceSelected: () => void;
  onPreferenceSaveError?: () => void;
};

/** Separates a durable endpoint preference from the current online selection. */
export function useActiveEndpointSelection({ devices, endpoints, snapshotDeviceIds, automaticSelectionPaused, onDeviceSelected, onPreferenceSaveError }: UseActiveEndpointSelectionOptions): ActiveEndpointSelection {
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [endpointPreference, setEndpointPreference] = useState<EndpointPreference>({
    deviceRecordId: null,
    endpointId: null,
    origin: null,
    loaded: true,
  });
  const activeDeviceIdRef = useRef<string | null>(null);
  const selectionEpochRef = useRef(0);
  const endpointRestoreGenerationRef = useRef(0);
  const endpointPreferencePersistEpochRef = useRef(0);
  const activeDevicePersistChainRef = useRef(Promise.resolve());
  const endpointPreferencePersistChainRef = useRef(Promise.resolve());
  const mountedRef = useRef(false);
  const onPreferenceSaveErrorRef = useRef(onPreferenceSaveError);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    onPreferenceSaveErrorRef.current = onPreferenceSaveError;
  }, [onPreferenceSaveError]);
  const activeDevice = useMemo(
    () => devices.find((device) => device.id === activeDeviceId) ?? null,
    [activeDeviceId, devices],
  );
  const activeDeviceRecordId = activeDevice?.id ?? null;

  const setCurrentDevice = useCallback((deviceId: string | null) => {
    const selectionEpoch = ++selectionEpochRef.current;
    activeDeviceIdRef.current = deviceId;
    setActiveDeviceId(deviceId);

    const pending = activeDevicePersistChainRef.current
      .catch(() => undefined)
      .then(async () => {
        if (selectionEpoch !== selectionEpochRef.current) return;
        const settings = getPwaDatabase().settings;
        try {
          if (deviceId === null) await settings.delete(ACTIVE_DEVICE_SETTING);
          else await settings.put({ key: ACTIVE_DEVICE_SETTING, value: deviceId });
        } catch {
          if (mountedRef.current && selectionEpoch === selectionEpochRef.current && activeDeviceIdRef.current === deviceId) onPreferenceSaveErrorRef.current?.();
        }
      });
    activeDevicePersistChainRef.current = pending.catch(() => undefined);
  }, []);

  useEffect(() => {
    const selectionEpoch = selectionEpochRef.current;
    const restoreGeneration = ++endpointRestoreGenerationRef.current;
    if (activeDeviceRecordId === null) {
      void Promise.resolve().then(() => {
        if (restoreGeneration !== endpointRestoreGenerationRef.current || selectionEpoch !== selectionEpochRef.current) return;
        setEndpointPreference({ deviceRecordId: null, endpointId: null, origin: null, loaded: true });
      });
      return;
    }

    void getPwaDatabase().settings.get(activeEndpointSettingKey(activeDeviceRecordId)).then(
      (setting) => {
        if (
          restoreGeneration !== endpointRestoreGenerationRef.current
          || selectionEpoch !== selectionEpochRef.current
          || activeDeviceIdRef.current !== activeDeviceRecordId
        ) return;
        setEndpointPreference({
          deviceRecordId: activeDeviceRecordId,
          endpointId: setting?.value ?? null,
          origin: setting?.value ? "restored" : null,
          loaded: true,
        });
      },
      () => {
        if (
          restoreGeneration !== endpointRestoreGenerationRef.current
          || selectionEpoch !== selectionEpochRef.current
          || activeDeviceIdRef.current !== activeDeviceRecordId
        ) return;
        setEndpointPreference({ deviceRecordId: activeDeviceRecordId, endpointId: null, origin: null, loaded: true });
      },
    );
  }, [activeDeviceRecordId]);

  const resolvedEndpoint = useMemo((): { id: string | null; origin: EndpointSelectionOrigin } => {
    if (
      !activeDevice
      || automaticSelectionPaused
      || endpointPreference.deviceRecordId !== activeDevice.id
      || !endpointPreference.loaded
    ) return { id: null, origin: null };

    const onlineEndpointIds = endpoints
      .filter((endpoint) => endpoint.deviceId === activeDevice.deviceId)
      .map((endpoint) => endpoint.endpointId);
    const preferredIsOnline = endpointPreference.endpointId !== null && onlineEndpointIds.includes(endpointPreference.endpointId);
    if (preferredIsOnline && endpointPreference.origin === "manual") {
      return { id: endpointPreference.endpointId, origin: endpointPreference.origin };
    }
    if (!snapshotDeviceIds.includes(activeDevice.deviceId)) return { id: null, origin: null };
    if (preferredIsOnline) return { id: endpointPreference.endpointId, origin: endpointPreference.origin };
    if (onlineEndpointIds.length === 1) return { id: onlineEndpointIds[0], origin: "automatic" };
    return { id: null, origin: null };
  }, [activeDevice, automaticSelectionPaused, endpointPreference, endpoints, snapshotDeviceIds]);

  const selectDevice = useCallback((deviceId: string | null) => {
    onDeviceSelected();
    if (deviceId === activeDeviceIdRef.current) return;
    ++endpointRestoreGenerationRef.current;
    ++endpointPreferencePersistEpochRef.current;
    setEndpointPreference({ deviceRecordId: deviceId, endpointId: null, origin: null, loaded: false });
    setCurrentDevice(deviceId);
  }, [onDeviceSelected, setCurrentDevice]);

  const selectEndpoint = useCallback((endpointId: string) => {
    const device = activeDevice;
    if (!device || activeDeviceIdRef.current !== device.id) return;
    ++endpointRestoreGenerationRef.current;
    const preferencePersistEpoch = ++endpointPreferencePersistEpochRef.current;
    setEndpointPreference({ deviceRecordId: device.id, endpointId, origin: "manual", loaded: true });

    const pending = endpointPreferencePersistChainRef.current
      .catch(() => undefined)
      .then(async () => {
        if (
          preferencePersistEpoch !== endpointPreferencePersistEpochRef.current
          || activeDeviceIdRef.current !== device.id
        ) return;
        try {
          await getPwaDatabase().settings.put({ key: activeEndpointSettingKey(device.id), value: endpointId });
        } catch {
          if (mountedRef.current && preferencePersistEpoch === endpointPreferencePersistEpochRef.current && activeDeviceIdRef.current === device.id) onPreferenceSaveErrorRef.current?.();
        }
      });
    endpointPreferencePersistChainRef.current = pending.catch(() => undefined);
  }, [activeDevice]);

  const restoreActiveDevice = useCallback((deviceId: string | null) => {
    if (deviceId !== activeDeviceIdRef.current) {
      setEndpointPreference({ deviceRecordId: deviceId, endpointId: null, origin: null, loaded: false });
    }
    setCurrentDevice(deviceId);
  }, [setCurrentDevice]);

  const activatePairedDevice = useCallback((deviceId: string, endpointId: string) => {
    ++endpointRestoreGenerationRef.current;
    ++endpointPreferencePersistEpochRef.current;
    setEndpointPreference({ deviceRecordId: deviceId, endpointId, origin: "manual", loaded: true });
    setCurrentDevice(deviceId);
  }, [setCurrentDevice]);

  const isActiveDevice = useCallback((deviceId: string) => activeDeviceIdRef.current === deviceId, []);

  return {
    activeDeviceId,
    activeEndpointId: resolvedEndpoint.id,
    activeEndpointOrigin: resolvedEndpoint.origin,
    activeDevice,
    selectDevice,
    selectEndpoint,
    restoreActiveDevice,
    activatePairedDevice,
    isActiveDevice,
  };
}
