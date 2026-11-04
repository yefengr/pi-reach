import { useEffect, useState } from "react";
import { BackgroundCompletionNotices, type BackgroundCompletionInput } from "@/lib/pwa/background-completion-notices";

export function useBackgroundCompletionNotices({ devices, endpoints, snapshotDeviceIds, viewingEndpoint }: BackgroundCompletionInput): ReadonlySet<string> {
  const [notices] = useState(() => new BackgroundCompletionNotices());
  const [completedEndpointIds, setCompletedEndpointIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    // 观察结果先保留在 tracker 内，避免后续 effect 取消微任务时吞掉刚发生的完成状态。
    const completed = notices.update({ devices, endpoints, snapshotDeviceIds, viewingEndpoint });
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) setCompletedEndpointIds(completed); });
    return () => { cancelled = true; };
  }, [devices, endpoints, notices, snapshotDeviceIds, viewingEndpoint]);
  return completedEndpointIds;
}
