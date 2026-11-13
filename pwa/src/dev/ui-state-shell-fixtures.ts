import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";
import type { TimelineSessionSummary } from "@/lib/pwa/timeline-store";

/** 只为真实导航组件提供内存元数据，不创建配对、身份或数据库记录。 */
export const GALLERY_DEVICES: PwaDeviceRecord[] = [
  { id: "gallery-computer", deviceId: "gallery-computer", relayUrl: "https://relay.invalid", pairedAt: "2026-01-01T00:00:00Z", hostname: "演示电脑", nickname: "工作电脑" },
  { id: "gallery-offline", deviceId: "gallery-offline", relayUrl: "https://relay.invalid", pairedAt: "2026-01-01T00:00:00Z", hostname: "另一台演示电脑", nickname: "离线电脑" },
];
export const GALLERY_ENDPOINTS: PwaEndpointRecord[] = [
  { id: "gallery-live", deviceId: "gallery-computer", endpointId: "gallery-live", runtimeInstanceId: "gallery-runtime", kind: "interactive", name: "阅读与对话布局", cwd: "/workspace/pi-reach", working: true, online: true, updatedAt: 1 },
  { id: "gallery-idle", deviceId: "gallery-computer", endpointId: "gallery-idle", runtimeInstanceId: "gallery-other-runtime", kind: "interactive", name: "另一段已完成的会话", cwd: "/workspace/pi-reach/pwa", working: false, online: true, updatedAt: 1 },
];
const DAY_MS = 24 * 60 * 60 * 1000;
/** 历史条目按打开展厅时的「昨天」取时间，列表显示「昨天」而不是 1970 年前后的日期。 */
const GALLERY_HISTORY_AT = Date.now() - DAY_MS;
export const GALLERY_HISTORY: TimelineSessionSummary[] = [
  { id: "gallery-history", deviceId: "gallery-computer", endpointId: "gallery-live", sessionId: "gallery-saved", leafId: "saved-leaf", startedAt: GALLERY_HISTORY_AT, updatedAt: GALLERY_HISTORY_AT, eventCount: 6, preview: "只读历史示例", name: "已保存的界面检查", model: "演示模型", thinking: "medium" },
  // 离线电脑没有在线 Pi，本地历史仍可打开。
  { id: "gallery-offline-history", deviceId: "gallery-offline", endpointId: "gallery-offline-pi", sessionId: "gallery-offline-saved", leafId: "offline-leaf", startedAt: GALLERY_HISTORY_AT, updatedAt: GALLERY_HISTORY_AT, eventCount: 4, preview: "离线电脑上的历史", name: "离线电脑的已保存会话", model: "演示模型", thinking: "medium" },
];
