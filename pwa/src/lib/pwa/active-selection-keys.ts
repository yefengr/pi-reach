export const ACTIVE_DEVICE_SETTING = "active_device";
export const ACTIVE_ENDPOINT_SETTING_PREFIX = "active_endpoint:";

export function activeEndpointSettingKey(deviceId: string): string {
  return `${ACTIVE_ENDPOINT_SETTING_PREFIX}${deviceId}`;
}
