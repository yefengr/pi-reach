import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";

export type PairingStatus = "online" | "checking" | "offline" | "partial";
export type PairingPresence = {
  status: PairingStatus;
  onlineEndpoints: number;
  totalEndpoints: number;
  lastSeenAt?: number;
};
export type DeviceActivity = "completed" | "running" | null;

/** Derives device-level endpoint presence without owning endpoint or session state. */
export function derivePairingPresence(
  devices: readonly PwaDeviceRecord[],
  endpoints: readonly PwaEndpointRecord[],
): Record<string, PairingPresence> {
  return Object.fromEntries(devices.map((device) => {
    const deviceEndpoints = endpoints.filter((endpoint) => endpoint.deviceId === device.deviceId);
    const onlineEndpoints = deviceEndpoints.filter((endpoint) => endpoint.online).length;
    const status: PairingStatus = deviceEndpoints.length === 0
      ? "checking"
      : onlineEndpoints === 0
        ? "offline"
        : onlineEndpoints === deviceEndpoints.length
          ? "online"
          : "partial";
    return [device.id, {
      status,
      onlineEndpoints,
      totalEndpoints: deviceEndpoints.length,
      lastSeenAt: deviceEndpoints.find((endpoint) => endpoint.online)?.updatedAt,
    }];
  }));
}

/**
 * 电脑行聚合状态：完成未查看优先于运行中，其次无标记。
 * completedDeviceIds 使用 wire deviceId；运行只认实时在线端口，缓存元数据不算在线。
 */
export function deriveDeviceActivity(
  devices: readonly Pick<PwaDeviceRecord, "id" | "deviceId">[],
  endpoints: readonly Pick<PwaEndpointRecord, "deviceId" | "online" | "working">[],
  completedDeviceIds: ReadonlySet<string>,
): Record<string, DeviceActivity> {
  return Object.fromEntries(devices.map((device) => {
    const activity: DeviceActivity = completedDeviceIds.has(device.deviceId)
      ? "completed"
      : endpoints.some((endpoint) => endpoint.deviceId === device.deviceId && endpoint.online === true && endpoint.working === true)
        ? "running"
        : null;
    return [device.id, activity];
  }));
}
