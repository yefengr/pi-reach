import { useEffect, useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { getPwaDatabase, makePwaDeviceId, makePwaEndpointId, openPwaDatabase, type PwaDeviceRecord } from "@/lib/pwa/db";
import type { ControlFrame } from "@/lib/pi-reach/types";
import { useEndpointRegistry, type EndpointRegistry } from "./use-endpoint-registry";

const device: PwaDeviceRecord = {
  id: makePwaDeviceId("owner-device-key"),
  deviceId: "owner-device-key",
  relayUrl: "https://relay.example.test",
  pairedAt: "2026-08-30T00:00:00.000Z",
  hostname: "test-host",
};
const endpointId = "daemon-endpoint";

type RegistryHarnessProps = {
  onRegistry: (registry: EndpointRegistry) => void;
  onError: (message: string) => void;
};

function RegistryHarness({ onRegistry, onError }: RegistryHarnessProps) {
  const registry = useEndpointRegistry({ devices: [device], activeDevice: device, onError });

  useEffect(() => { onRegistry(registry); }, [onRegistry, registry]);
  return <output data-testid="endpoint-count">{registry.endpoints.length}</output>;
}

function RecreatingDevicesHarness({ onRegistry, onError }: RegistryHarnessProps) {
  const [renderCount, setRenderCount] = useState(0);
  const registry = useEndpointRegistry({ devices: [device], activeDevice: device, onError });

  useEffect(() => { onRegistry(registry); }, [onRegistry, registry]);
  useEffect(() => {
    const rerenderTimer = setTimeout(() => setRenderCount(1), 0);
    return () => clearTimeout(rerenderTimer);
  }, []);
  return <output data-testid="parent-render-count">{renderCount}</output>;
}

async function renderRegistry() {
  let registry: EndpointRegistry | null = null;
  const errors: string[] = [];
  const screen = await renderPwa(<RegistryHarness onRegistry={(next) => { registry = next; }} onError={(message) => { errors.push(message); }} />);
  await vi.waitFor(() => expect(registry).not.toBeNull());
  return {
    screen,
    errors,
    registry: () => {
      if (!registry) throw new Error("Endpoint registry did not mount.");
      return registry;
    },
  };
}

function endpointUpdated(runtimeInstanceId: string, name: string): Extract<ControlFrame, { type: "endpoint_updated" }> {
  return {
    type: "endpoint_updated",
    device_id: device.deviceId,
    endpoint_id: endpointId,
    runtime_instance_id: runtimeInstanceId,
    metadata: { kind: "daemon", name, cwd: "/workspace" },
  };
}

function endpointEnded(runtimeInstanceId: string): Extract<ControlFrame, { type: "endpoint_ended" }> {
  return {
    type: "endpoint_ended",
    device_id: device.deviceId,
    endpoint_id: endpointId,
    runtime_instance_id: runtimeInstanceId,
  };
}

beforeEach(async () => {
  const database = await openPwaDatabase();
  await database.transaction("rw", [database.devices, database.endpoints], async () => {
    await Promise.all([database.devices.clear(), database.endpoints.clear()]);
    await database.devices.put(device);
  });
});

test("does not loop when the parent recreates the devices array", async () => {
  let registry: EndpointRegistry | null = null;
  const screen = await renderPwa(
    <RecreatingDevicesHarness onRegistry={(next) => { registry = next; }} onError={() => {}} />,
  );

  await vi.waitFor(() => expect(registry).not.toBeNull());
  await expect.element(screen.getByTestId("parent-render-count")).toHaveTextContent("1");
  await screen.unmount();
});

test("does not hydrate cached metadata into the online registry", async () => {
  const database = getPwaDatabase();
  await database.endpoints.put({
    id: makePwaEndpointId(device.deviceId, endpointId),
    deviceId: device.deviceId,
    endpointId,
    runtimeInstanceId: "cached-runtime",
    kind: "daemon",
    name: "Cached endpoint",
    online: true,
    updatedAt: Date.now(),
  });

  const { registry, screen } = await renderRegistry();
  await vi.waitFor(() => expect(registry().endpoints).toEqual([]));
  expect(registry().snapshotDeviceIds).toEqual([]);
  await screen.unmount();
});

test("keeps snapshot endpoints when a second endpoint is announced", async () => {
  const { registry, screen } = await renderRegistry();
  const interactiveEndpointId = "interactive-endpoint";
  try {
    registry().applyControl({
      type: "endpoints",
      device_id: device.deviceId,
      endpoints: [{
        endpoint_id: endpointId,
        runtime_instance_id: "daemon-runtime",
        metadata: {
          kind: "daemon",
          name: "Snapshot daemon",
          cwd: "/workspace",
          pid: 42,
          started_at: 1700000000,
          model: "test-model",
          thinking: "high",
          working: true,
        },
      }],
    });
    await vi.waitFor(() => expect(registry().endpoints).toHaveLength(1));

    expect(registry().endpoints).toHaveLength(1);
    expect(registry().endpoints.find((endpoint) => endpoint.endpointId === endpointId)).toMatchObject({
      id: makePwaEndpointId(device.deviceId, endpointId),
      deviceId: device.deviceId,
      endpointId,
      runtimeInstanceId: "daemon-runtime",
      kind: "daemon",
      name: "Snapshot daemon",
      cwd: "/workspace",
      pid: 42,
      startedAt: 1700000000,
      model: "test-model",
      thinking: "high",
      working: true,
      online: true,
    });

    registry().applyControl({
      type: "endpoint_announced",
      device_id: device.deviceId,
      endpoint_id: interactiveEndpointId,
      runtime_instance_id: "interactive-runtime",
      metadata: {
        kind: "interactive",
        name: "Interactive endpoint",
        cwd: "/workspace/app",
        pid: 43,
        started_at: 1700000100,
        model: "interactive-model",
        thinking: "medium",
        working: false,
      },
    });
    await vi.waitFor(() => expect(registry().endpoints).toHaveLength(2));

    expect(registry().endpoints).toHaveLength(2);
    expect(registry().endpoints.find((endpoint) => endpoint.endpointId === endpointId)).toMatchObject({
      id: makePwaEndpointId(device.deviceId, endpointId),
      deviceId: device.deviceId,
      endpointId,
      runtimeInstanceId: "daemon-runtime",
      kind: "daemon",
      name: "Snapshot daemon",
      cwd: "/workspace",
      pid: 42,
      startedAt: 1700000000,
      model: "test-model",
      thinking: "high",
      working: true,
      online: true,
    });
    expect(registry().endpoints.find((endpoint) => endpoint.endpointId === interactiveEndpointId)).toMatchObject({
      id: makePwaEndpointId(device.deviceId, interactiveEndpointId),
      deviceId: device.deviceId,
      endpointId: interactiveEndpointId,
      runtimeInstanceId: "interactive-runtime",
      kind: "interactive",
      name: "Interactive endpoint",
      cwd: "/workspace/app",
      pid: 43,
      startedAt: 1700000100,
      model: "interactive-model",
      thinking: "medium",
      working: false,
      online: true,
    });
  } finally {
    await screen.unmount();
  }
});

test("rejects late events from a runtime replaced by endpoint_updated", async () => {
  const { registry, screen } = await renderRegistry();
  registry().applyControl(endpointUpdated("runtime-old", "Old runtime"));
  await vi.waitFor(() => expect(registry().endpoints[0]).toMatchObject({ runtimeInstanceId: "runtime-old", name: "Old runtime", online: true }));

  registry().applyControl(endpointUpdated("runtime-new", "New runtime"));
  await vi.waitFor(() => expect(registry().endpoints[0]).toMatchObject({ runtimeInstanceId: "runtime-new", name: "New runtime", online: true }));

  registry().applyControl(endpointUpdated("runtime-old", "Late old runtime"));
  await vi.waitFor(() => expect(registry().endpoints[0]).toMatchObject({ runtimeInstanceId: "runtime-new", name: "New runtime", online: true }));
  await screen.unmount();
});

test("only endpoint_ended for the matching runtime removes the online endpoint", async () => {
  const { registry, screen } = await renderRegistry();
  registry().applyControl(endpointUpdated("runtime-1", "Current runtime"));
  await vi.waitFor(() => expect(registry().endpoints[0]).toMatchObject({ runtimeInstanceId: "runtime-1", online: true }));

  const database = getPwaDatabase();
  await database.events.put({
    id: "history",
    deviceId: device.deviceId,
    endpointId,
    sessionId: "session",
    leafId: "generation", eventId: "event",
    timestamp: 1,
    event: { event_id: "event", session_id: "session", leaf_id: "generation", timestamp: 1, kind: "custom", payload: { notice: true }, truncated: false },
  });

  registry().applyControl(endpointEnded("runtime-other"));
  await vi.waitFor(() => expect(registry().endpoints[0]).toMatchObject({ runtimeInstanceId: "runtime-1", online: true }));

  registry().applyControl(endpointEnded("runtime-1"));
  await vi.waitFor(() => expect(registry().endpoints).toEqual([]));
  await vi.waitFor(async () => expect(await database.endpoints.get(makePwaEndpointId(device.deviceId, endpointId))).toBeUndefined());
  expect(await database.events.get("history")).toBeDefined();
  await screen.unmount();
});

test("applies each endpoints snapshot as the current authoritative device view", async () => {
  const { registry, screen } = await renderRegistry();
  registry().applyControl(endpointUpdated("runtime-new", "New runtime"));
  await vi.waitFor(() => expect(registry().endpoints[0]).toMatchObject({ runtimeInstanceId: "runtime-new" }));

  registry().applyControl({
    type: "endpoints",
    device_id: device.deviceId,
    endpoints: [{
      endpoint_id: endpointId,
      runtime_instance_id: "runtime-snapshot",
      metadata: { kind: "daemon", name: "Snapshot runtime" },
    }],
  });

  await vi.waitFor(() => expect(registry().endpoints).toMatchObject([
    { endpointId, runtimeInstanceId: "runtime-snapshot", name: "Snapshot runtime", online: true },
  ]));
  await screen.unmount();
});

test("relay disconnect clears only the online registry", async () => {
  const { registry, screen } = await renderRegistry();
  registry().applyControl(endpointUpdated("runtime-1", "Persisted endpoint"));
  const id = makePwaEndpointId(device.deviceId, endpointId);
  await vi.waitFor(async () => expect(await getPwaDatabase().endpoints.get(id)).toBeDefined());

  registry().markAllOffline();
  await vi.waitFor(() => expect(registry().endpoints).toEqual([]));
  expect(registry().snapshotDeviceIds).toEqual([]);
  expect(await getPwaDatabase().endpoints.get(id)).toMatchObject({ runtimeInstanceId: "runtime-1" });
  await screen.unmount();
});

test("treats snapshots as authoritative and deletes omitted cache records", async () => {
  const database = getPwaDatabase();
  const omittedId = makePwaEndpointId(device.deviceId, "omitted");
  await database.endpoints.put({ id: omittedId, deviceId: device.deviceId, endpointId: "omitted", runtimeInstanceId: "old", kind: "interactive", updatedAt: 1 });
  const { registry, screen } = await renderRegistry();
  registry().applyControl({ type: "endpoints", device_id: device.deviceId, endpoints: [] });
  await vi.waitFor(() => expect(registry().snapshotDeviceIds).toContain(device.deviceId));
  expect(registry().endpoints).toEqual([]);
  await vi.waitFor(async () => expect(await database.endpoints.get(omittedId)).toBeUndefined());
  await screen.unmount();
});

test("persists endpoint records without online presence", async () => {
  const { registry, screen } = await renderRegistry();
  registry().applyControl(endpointUpdated("runtime-1", "Persisted endpoint"));

  const database = getPwaDatabase();
  const id = makePwaEndpointId(device.deviceId, endpointId);
  await vi.waitFor(async () => expect(await database.endpoints.get(id)).toBeDefined());
  const persisted = await database.endpoints.get(id);
  expect(persisted).toMatchObject({ id, runtimeInstanceId: "runtime-1", name: "Persisted endpoint" });
  expect(persisted).not.toHaveProperty("online");
  await screen.unmount();
});
