import { describe, expect, test } from "vitest";
import { detectInstallGuide, type InstallGuideEnvironment } from "./install-guide";

const userAgents = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1",
  ipadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  macSafari17: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  macSafari16: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  macEdge: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0",
  androidChrome: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
} as const;

function environment(userAgent: string, overrides: Partial<InstallGuideEnvironment> = {}): InstallGuideEnvironment {
  return { userAgent, maxTouchPoints: 0, standalone: false, ...overrides };
}

describe("detectInstallGuide", () => {
  test("guides every iOS browser to the Share menu", () => {
    expect(detectInstallGuide(environment(userAgents.iphoneSafari, { maxTouchPoints: 5 }))).toBe("ios");
    expect(detectInstallGuide(environment(userAgents.iphoneChrome, { maxTouchPoints: 5 }))).toBe("ios");
  });

  test("treats a touch-capable desktop-mode iPad as iOS", () => {
    expect(detectInstallGuide(environment(userAgents.ipadDesktop, { maxTouchPoints: 5 }))).toBe("ios");
  });

  test("guides Mac Safari 17 and later to Add to Dock", () => {
    expect(detectInstallGuide(environment(userAgents.macSafari17))).toBe("mac-safari");
    expect(detectInstallGuide(environment(userAgents.macSafari16))).toBeNull();
  });

  test("leaves other Mac browsers to their own install flow", () => {
    expect(detectInstallGuide(environment(userAgents.macChrome))).toBeNull();
    expect(detectInstallGuide(environment(userAgents.macEdge))).toBeNull();
    expect(detectInstallGuide(environment(userAgents.macFirefox))).toBeNull();
  });

  test("does not guide Android or Windows browsers", () => {
    expect(detectInstallGuide(environment(userAgents.androidChrome, { maxTouchPoints: 5 }))).toBeNull();
    expect(detectInstallGuide(environment(userAgents.windowsChrome))).toBeNull();
  });

  test("stays hidden once opened from the Home Screen or Dock", () => {
    expect(detectInstallGuide(environment(userAgents.iphoneSafari, { maxTouchPoints: 5, standalone: true }))).toBeNull();
    expect(detectInstallGuide(environment(userAgents.macSafari17, { standalone: true }))).toBeNull();
  });
});
