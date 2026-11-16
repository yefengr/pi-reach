import { displayPi } from "@/components/pwa/session-title";
import type { PwaEndpointRecord } from "@/lib/pwa/db";

/** 在线 Pi 行唯一的状态来源：运行优先于后台完成提醒，当前查看的会话不显示完成点。 */
export type OnlinePiStatus = "running" | "completed" | "idle";

export function getOnlinePiStatus(endpoint: Pick<PwaEndpointRecord, "working">, current: boolean, completed: boolean): OnlinePiStatus {
  if (endpoint.working) return "running";
  if (completed && !current) return "completed";
  return "idle";
}

/** 列表顺序与行状态同源：完成未查看、运行中、其余；同档按显示名与 id 稳定排序。 */
const STATUS_RANK: Record<OnlinePiStatus, number> = { completed: 0, running: 1, idle: 2 };

function compareOnlinePis(
  left: PwaEndpointRecord,
  right: PwaEndpointRecord,
  completedEndpointIds: ReadonlySet<string>,
  currentEndpointId: string | null,
): number {
  const leftStatus = getOnlinePiStatus(left, left.endpointId === currentEndpointId, completedEndpointIds.has(left.endpointId));
  const rightStatus = getOnlinePiStatus(right, right.endpointId === currentEndpointId, completedEndpointIds.has(right.endpointId));
  const byStatus = STATUS_RANK[leftStatus] - STATUS_RANK[rightStatus];
  if (byStatus !== 0) return byStatus;
  // 同名时用 id 保证顺序稳定；updatedAt 只表示元数据更新时间，不参与排序。
  return displayPi(left).localeCompare(displayPi(right)) || left.id.localeCompare(right.id);
}

/** 返回排序后的拷贝，不修改调用方数组或完成集合；current 用于抑制当前会话的完成档位。 */
export function sortOnlinePis(
  endpoints: readonly PwaEndpointRecord[],
  completedEndpointIds?: ReadonlySet<string>,
  currentEndpointId?: string | null,
): PwaEndpointRecord[] {
  const completed = completedEndpointIds ?? new Set<string>();
  const current = currentEndpointId ?? null;
  return [...endpoints].sort((left, right) => compareOnlinePis(left, right, completed, current));
}
