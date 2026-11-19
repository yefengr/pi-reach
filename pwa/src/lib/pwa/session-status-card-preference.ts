import { useLocalStorage } from "@mantine/hooks";

export const SESSION_STATUS_CARD_STORAGE_KEY = "pi-reach-session-status-card";

/** 桌面会话状态卡的显示偏好；与发送键偏好一致，只有字符串 "false" 视为关闭。 */
export function useSessionStatusCardPreference() {
  return useLocalStorage<boolean>({
    key: SESSION_STATUS_CARD_STORAGE_KEY,
    defaultValue: true,
    getInitialValueInEffect: false,
    deserialize: (value) => value !== "false",
  });
}
