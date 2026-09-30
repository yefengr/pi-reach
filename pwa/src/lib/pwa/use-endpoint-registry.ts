import { useCallback, useEffect, useRef, useState } from "react";
import { acceptEndpointRuntime } from "@/lib/pwa/runtime";
import {
  getPwaDatabase,
  makePwaDeviceId,
  makePwaEndpointId,
  type PwaDeviceRecord,
  type PwaEndpointRecord,
} from "@/lib/pwa/db";
import type { ControlFrame } from "@/lib/pi-reach/types";

export type UseEndpointRegistryOptions = {
  devices: readonly PwaDeviceRecord[];
  activeDevice: PwaDeviceRecord | null;
  onError: (message: string) => void;
};

export type EndpointRegistry = {
  endpoints: PwaEndpointRecord[];
  snapshotDeviceIds: readonly string[];
  applyControl: (frame: ControlFrame) => void;
  markAllOffline: () => void;
  invalidatePersistence: () => Promise<void>;
};

function toEndpointRecord(deviceId: string, endpoint: Extract<ControlFrame, { type: "endpoints" }>["endpoints"][number]): PwaEndpointRecord {
  const metadata = endpoint.metadata;
  return { id: makePwaEndpointId(deviceId, endpoint.endpoint_id), deviceId, endpointId: endpoint.endpoint_id, runtimeInstanceId: endpoint.runtime_instance_id, kind: metadata.kind, name: metadata.name ?? undefined, cwd: metadata.cwd ?? undefined, pid: metadata.pid ?? undefined, startedAt: metadata.started_at ?? undefined, model: metadata.model ?? undefined, thinking: metadata.thinking ?? undefined, working: metadata.working ?? undefined, online: true, updatedAt: Date.now() };
}

function endpointRecordFromEvent(frame: Extract<ControlFrame, { type: "endpoint_announced" | "endpoint_updated" }>): PwaEndpointRecord {
  return toEndpointRecord(frame.device_id, { endpoint_id: frame.endpoint_id, runtime_instance_id: frame.runtime_instance_id, metadata: frame.metadata });
}

function withoutPresence(endpoint: PwaEndpointRecord): PwaEndpointRecord {
  const record = { ...endpoint };
  delete record.online;
  return record;
}

const ENDPOINT_CONTENT_KEYS = [
  "id",
  "deviceId",
  "endpointId",
  "runtimeInstanceId",
  "kind",
  "name",
  "cwd",
  "pid",
  "startedAt",
  "model",
  "thinking",
  "working",
  "online",
] as const satisfies readonly (keyof PwaEndpointRecord)[];

function sameEndpointRecord(left: PwaEndpointRecord, right: PwaEndpointRecord): boolean {
  return ENDPOINT_CONTENT_KEYS.every((key) => left[key] === right[key]);
}

function sameEndpointRecords(left: readonly PwaEndpointRecord[], right: readonly PwaEndpointRecord[]): boolean {
  return left.length === right.length && left.every((endpoint, index) => sameEndpointRecord(endpoint, right[index]));
}

function recordSnapshotRuntime(history: Map<string, Set<string>>, endpoint: PwaEndpointRecord): void {
  const runtimes = history.get(endpoint.id) ?? new Set<string>();
  runtimes.delete(endpoint.runtimeInstanceId);
  runtimes.add(endpoint.runtimeInstanceId);
  history.set(endpoint.id, runtimes);
}

export function useEndpointRegistry({ devices, onError }: UseEndpointRegistryOptions): EndpointRegistry {
  const [endpoints, setEndpoints] = useState<PwaEndpointRecord[]>([]);
  const [snapshotDeviceIds, setSnapshotDeviceIds] = useState<string[]>([]);
  const devicesRef = useRef(devices);
  const endpointsRef = useRef(endpoints);
  const onErrorRef = useRef(onError);
  const endpointRuntimeHistoryRef = useRef(new Map<string, Set<string>>());
  const endpointPersistEpochRef = useRef(0);
  const endpointPersistChainRef = useRef(Promise.resolve());

  const updateEndpoints = useCallback((update: PwaEndpointRecord[] | ((current: PwaEndpointRecord[]) => PwaEndpointRecord[])) => {
    const current = endpointsRef.current;
    const next = typeof update === "function" ? update(current) : update;
    if (sameEndpointRecords(current, next)) {
      endpointsRef.current = current;
      return;
    }
    endpointsRef.current = next;
    setEndpoints(next);
  }, []);

  useEffect(() => {
    devicesRef.current = devices;
    const reconcileTimer = setTimeout(() => {
      const deviceIds = new Set(devicesRef.current.map((device) => device.deviceId));
      updateEndpoints((current) => current.filter((endpoint) => deviceIds.has(endpoint.deviceId)));
      setSnapshotDeviceIds((current) => {
        const next = current.filter((deviceId) => deviceIds.has(deviceId));
        return next.length === current.length ? current : next;
      });
    }, 0);
    return () => clearTimeout(reconcileTimer);
  }, [devices, updateEndpoints]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const queuePersistence = useCallback((operation: () => Promise<void>) => {
    const epoch = endpointPersistEpochRef.current;
    const pending = endpointPersistChainRef.current.then(async () => {
      if (epoch !== endpointPersistEpochRef.current) return;
      await operation();
    });
    endpointPersistChainRef.current = pending.catch(() => undefined);
    void pending.catch(() => onErrorRef.current("Could not update local Pi details."));
  }, []);

  const persistSnapshot = useCallback((deviceId: string, next: PwaEndpointRecord[]) => {
    queuePersistence(async () => {
      const database = getPwaDatabase();
      if (!await database.devices.get(makePwaDeviceId(deviceId))) return;
      await database.transaction("rw", database.endpoints, async () => {
        await database.endpoints.where("deviceId").equals(deviceId).delete();
        if (next.length > 0) await database.endpoints.bulkPut(next.map(withoutPresence));
      });
    });
  }, [queuePersistence]);

  const persistEndpoint = useCallback((endpoint: PwaEndpointRecord) => {
    queuePersistence(async () => {
      const database = getPwaDatabase();
      if (!await database.devices.get(makePwaDeviceId(endpoint.deviceId))) return;
      await database.endpoints.put(withoutPresence(endpoint));
    });
  }, [queuePersistence]);

  const removeEndpoint = useCallback((endpoint: PwaEndpointRecord) => {
    queuePersistence(async () => {
      const database = getPwaDatabase();
      const stored = await database.endpoints.get(endpoint.id);
      if (stored?.runtimeInstanceId === endpoint.runtimeInstanceId) await database.endpoints.delete(endpoint.id);
    });
  }, [queuePersistence]);

  const invalidatePersistence = useCallback(async () => {
    endpointPersistEpochRef.current += 1;
    await endpointPersistChainRef.current;
  }, []);

  const applyControl = useCallback((frame: ControlFrame) => {
    if (frame.type === "pairing_target" || frame.type === "pairing_code_error") return;
    const device = devicesRef.current.find((candidate) => candidate.deviceId === frame.device_id);
    if (!device) return;
    if (frame.type === "endpoints") {
      const byId = new Map<string, PwaEndpointRecord>();
      for (const endpoint of frame.endpoints) {
        const record = toEndpointRecord(frame.device_id, endpoint);
        byId.set(record.id, record);
      }
      const snapshot = [...byId.values()];
      for (const endpoint of snapshot) recordSnapshotRuntime(endpointRuntimeHistoryRef.current, endpoint);
      updateEndpoints((all) => [...all.filter((endpoint) => endpoint.deviceId !== frame.device_id), ...snapshot]);
      setSnapshotDeviceIds((all) => all.includes(frame.device_id) ? all : [...all, frame.device_id]);
      persistSnapshot(frame.device_id, snapshot);
      return;
    }
    if (frame.type === "endpoint_announced" || frame.type === "endpoint_updated") {
      const next = endpointRecordFromEvent(frame);
      const current = endpointsRef.current.find((endpoint) => endpoint.id === next.id);
      if (!acceptEndpointRuntime(endpointRuntimeHistoryRef.current, current, next)) return;
      updateEndpoints((all) => [...all.filter((endpoint) => endpoint.id !== next.id), next]);
      persistEndpoint(next);
      return;
    }
    const ended = endpointsRef.current.find((endpoint) => endpoint.deviceId === frame.device_id && endpoint.endpointId === frame.endpoint_id && endpoint.runtimeInstanceId === frame.runtime_instance_id);
    if (!ended) return;
    updateEndpoints((all) => all.filter((endpoint) => endpoint.id !== ended.id));
    removeEndpoint(ended);
  }, [persistEndpoint, persistSnapshot, removeEndpoint, updateEndpoints]);

  const markAllOffline = useCallback(() => {
    updateEndpoints([]);
    setSnapshotDeviceIds((current) => current.length === 0 ? current : []);
  }, [updateEndpoints]);

  return { endpoints, snapshotDeviceIds, applyControl, markAllOffline, invalidatePersistence };
}
