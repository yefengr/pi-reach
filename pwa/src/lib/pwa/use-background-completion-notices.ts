import { useEffect, useState } from "react";
import { BackgroundCompletionNotices, type BackgroundCompletionInput } from "@/lib/pwa/background-completion-notices";

export type BackgroundCompletionNoticeSets = {
  completedEndpointIds: ReadonlySet<string>;
  completedDeviceIds: ReadonlySet<string>;
};

export function useBackgroundCompletionNotices({ devices, endpoints, snapshotDeviceIds, viewingEndpoint }: BackgroundCompletionInput): BackgroundCompletionNoticeSets {
  const [notices] = useState(() => new BackgroundCompletionNotices());
  const [completed, setCompleted] = useState<BackgroundCompletionNoticeSets>(() => ({ completedEndpointIds: new Set(), completedDeviceIds: new Set() }));
  useEffect(() => {
    // 观察结果先保留在 tracker 内，避免后续 effect 取消微任务时吞掉刚发生的完成状态。
    const completedEndpointIds = notices.update({ devices, endpoints, snapshotDeviceIds, viewingEndpoint });
    const completedDeviceIds = notices.getCompletedDeviceIds();
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) setCompleted({ completedEndpointIds, completedDeviceIds }); });
    return () => { cancelled = true; };
  }, [devices, endpoints, notices, snapshotDeviceIds, viewingEndpoint]);
  return completed;
}
