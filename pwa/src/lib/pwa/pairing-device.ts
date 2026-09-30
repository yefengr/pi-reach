export type PairingDeviceNavigator = Pick<Navigator, "userAgent" | "maxTouchPoints">;

const mobilePairingUserAgent = /\b(?:iPhone|iPad|iPod|Android)\b/i;
const desktopIpadUserAgent = /\bMacintosh\b/i;

export function isPairingCameraDevice(device: PairingDeviceNavigator | undefined): boolean {
  if (!device) return false;
  if (mobilePairingUserAgent.test(device.userAgent)) return true;
  return desktopIpadUserAgent.test(device.userAgent) && device.maxTouchPoints > 1;
}
