import { expect, test } from "vitest";
import type { PwaDeviceRecord, PwaEndpointRecord } from "./db";
import { deriveDeviceActivity, derivePairingPresence } from "./pwa-view-model";

function device(id: string, deviceId = id): PwaDeviceRecord {
  return { id, deviceId, relayUrl: "https://relay.example.test", pairedAt: "2026-09-03T00:00:00.000Z" };
}

function endpoint(deviceId: string, endpointId: string, online: boolean | undefined, updatedAt: number, working?: boolean): PwaEndpointRecord {
  return {
    id: `${deviceId}:${endpointId}`,
    deviceId,
    endpointId,
    runtimeInstanceId: `runtime-${endpointId}`,
    kind: "daemon",
    online,
    working,
    updatedAt,
  };
}

test("marks a device without discovered endpoints as checking", () => {
  expect(derivePairingPresence([device("device-a")], [])).toEqual({
    "device-a": { status: "checking", onlineEndpoints: 0, totalEndpoints: 0, lastSeenAt: undefined },
  });
});

test("derives offline, online, and partial device presence", () => {
  const devices = [device("offline"), device("online"), device("partial")];
  const endpoints = [
    endpoint("offline", "one", false, 1),
    endpoint("offline", "two", undefined, 2),
    endpoint("online", "one", true, 3),
    endpoint("online", "two", true, 4),
    endpoint("partial", "one", true, 5),
    endpoint("partial", "two", false, 6),
  ];

  expect(derivePairingPresence(devices, endpoints)).toEqual({
    offline: { status: "offline", onlineEndpoints: 0, totalEndpoints: 2, lastSeenAt: undefined },
    online: { status: "online", onlineEndpoints: 2, totalEndpoints: 2, lastSeenAt: 3 },
    partial: { status: "partial", onlineEndpoints: 1, totalEndpoints: 2, lastSeenAt: 5 },
  });
});

test("matches completion by wire device id and keys activity by local device record", () => {
  const devices = [device("record-a", "device-a")];
  // 本地记录 id 与 wire deviceId 不同：只按 wire 身份匹配完成集合。
  expect(deriveDeviceActivity(devices, [], new Set(["record-a"]))).toEqual({ "record-a": null });
  expect(deriveDeviceActivity(devices, [], new Set(["device-a"]))).toEqual({ "record-a": "completed" });
});

test("derives per-computer activity with completed priority and online-only running", () => {
  const devices = [device("record-a", "device-a"), device("record-b", "device-b"), device("record-c", "device-c")];
  const endpoints = [
    endpoint("device-a", "busy", true, 1, true),
    endpoint("device-b", "busy", true, 2, true),
    endpoint("device-c", "cached", false, 3, true),
    endpoint("device-c", "unknown", undefined, 4, true),
  ];

  expect(deriveDeviceActivity(devices, endpoints, new Set(["device-a"]))).toEqual({
    "record-a": "completed",
    "record-b": "running",
    "record-c": null,
  });
  // 无完成标记时，只有实时在线且运行中的端口让电脑显示运行；离线缓存元数据不算。
  expect(deriveDeviceActivity(devices, endpoints, new Set())).toEqual({
    "record-a": "running",
    "record-b": "running",
    "record-c": null,
  });
});

test("isolates endpoints by device identity and keeps the first online timestamp", () => {
  const devices = [device("record-a", "device-a"), device("record-b", "device-b")];
  const endpoints = [
    endpoint("device-b", "other", true, 90),
    endpoint("device-a", "first", true, 20),
    endpoint("device-a", "second", true, 80),
  ];

  expect(derivePairingPresence(devices, endpoints)).toEqual({
    "record-a": { status: "online", onlineEndpoints: 2, totalEndpoints: 2, lastSeenAt: 20 },
    "record-b": { status: "online", onlineEndpoints: 1, totalEndpoints: 1, lastSeenAt: 90 },
  });
});
