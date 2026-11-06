/** 浏览器不会触发 `beforeinstallprompt`、只能由用户手动添加时的安装引导。 */
export type InstallGuide = "ios" | "mac-safari";

export type InstallGuideEnvironment = {
  userAgent: string;
  maxTouchPoints: number;
  /** 已从主屏幕或程序坞以独立窗口打开。 */
  standalone: boolean;
};

const iosUserAgent = /\b(?:iPhone|iPad|iPod)\b/i;
const macUserAgent = /\bMacintosh\b/i;
const safariVersion = /\bVersion\/(\d+)(?:\.\d+)*.*\bSafari\//;
// Mac 上的其他浏览器同样带 Safari 标识，需要排除。
const nonSafariMacBrowser = /\b(?:Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS)\//;
// Safari 17 起支持「添加到程序坞」。
const MIN_MAC_SAFARI_DOCK_VERSION = 17;

export function detectInstallGuide({ userAgent, maxTouchPoints, standalone }: InstallGuideEnvironment): InstallGuide | null {
  if (standalone) return null;
  if (iosUserAgent.test(userAgent)) return "ios";
  if (!macUserAgent.test(userAgent)) return null;
  // iPadOS 默认以 Mac 身份请求桌面网页，只能靠多点触控区分。
  if (maxTouchPoints > 1) return "ios";
  if (nonSafariMacBrowser.test(userAgent)) return null;
  const version = Number(safariVersion.exec(userAgent)?.[1] ?? 0);
  return version >= MIN_MAC_SAFARI_DOCK_VERSION ? "mac-safari" : null;
}

export function readInstallGuideEnvironment(): InstallGuideEnvironment {
  const standalone = window.matchMedia("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return { userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, standalone };
}
