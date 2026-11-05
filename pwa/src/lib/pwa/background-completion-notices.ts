import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";

type Endpoint = Pick<PwaEndpointRecord, "id" | "deviceId" | "endpointId" | "runtimeInstanceId" | "working" | "online">;
type ViewingEndpoint = Pick<Endpoint, "deviceId" | "endpointId" | "runtimeInstanceId">;
type ObservedEndpoint = ViewingEndpoint & { working: boolean; completed: boolean };

export type BackgroundCompletionInput = {
  devices: readonly Pick<PwaDeviceRecord, "deviceId">[];
  endpoints: readonly Endpoint[];
  snapshotDeviceIds: readonly string[];
  viewingEndpoint: ViewingEndpoint | null;
};

/** 仅保存在页面内存中；断线不等于已查看，也不等于 Pi 已退出。 */
export class BackgroundCompletionNotices {
  private readonly observed = new Map<string, ObservedEndpoint>();
  private completedEndpointIds: ReadonlySet<string> = new Set();

  update({ devices, endpoints, snapshotDeviceIds, viewingEndpoint }: BackgroundCompletionInput): ReadonlySet<string> {
    const paired = new Set(devices.map((device) => device.deviceId));
    const confirmed = new Set(snapshotDeviceIds);
    const online = new Map(endpoints.filter((endpoint) => endpoint.online !== false).map((endpoint) => [endpoint.id, endpoint]));

    for (const [id, previous] of this.observed) {
      const endpoint = online.get(id);
      // 快照逐台返回：只清理已确认电脑的缺失项，不能由另一台电脑的回包推断退出。
      if (!paired.has(previous.deviceId)
        || !endpoint && confirmed.has(previous.deviceId)
        || endpoint && endpoint.runtimeInstanceId !== previous.runtimeInstanceId) this.observed.delete(id);
    }

    for (const endpoint of online.values()) {
      if (!paired.has(endpoint.deviceId)) continue;
      const previous = this.observed.get(endpoint.id);
      const working = endpoint.working === true;
      const viewing = viewingEndpoint !== null
        && endpoint.deviceId === viewingEndpoint.deviceId
        && endpoint.endpointId === viewingEndpoint.endpointId
        && endpoint.runtimeInstanceId === viewingEndpoint.runtimeInstanceId;
      this.observed.set(endpoint.id, {
        deviceId: endpoint.deviceId,
        endpointId: endpoint.endpointId,
        runtimeInstanceId: endpoint.runtimeInstanceId,
        working,
        completed: !viewing && (previous?.completed === true || previous?.working === true && !working),
      });
    }

    const completed = new Set([...this.observed.values()].filter((endpoint) => endpoint.completed).map((endpoint) => endpoint.endpointId));
    if (completed.size !== this.completedEndpointIds.size || [...completed].some((id) => !this.completedEndpointIds.has(id))) {
      this.completedEndpointIds = completed;
    }
    return this.completedEndpointIds;
  }
}
