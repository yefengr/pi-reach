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
export const GALLERY_HISTORY: TimelineSessionSummary[] = [
  { id: "gallery-history", deviceId: "gallery-computer", endpointId: "gallery-live", sessionId: "gallery-saved", leafId: "saved-leaf", startedAt: 1, updatedAt: 1, eventCount: 6, preview: "只读历史示例", name: "已保存的界面检查", model: "演示模型", thinking: "medium" },
];
