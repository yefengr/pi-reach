export type PwaTextSize = "standard" | "large" | "xlarge";
export type PwaTextSizePreference = "system" | PwaTextSize;
const SYSTEM_BODY_FONT = "-apple-system-body";
const SYSTEM_LARGE_MIN_PX = 18;
const SYSTEM_XLARGE_MIN_PX = 20;

export function textSizeForSystemBody(px: number | null): PwaTextSize {
  if (px === null || !Number.isFinite(px)) return "standard";
  if (px >= SYSTEM_XLARGE_MIN_PX) return "xlarge";
  return px >= SYSTEM_LARGE_MIN_PX ? "large" : "standard";
}

/** 只实测系统正文字号，不读写偏好；探针无论成功或异常都清理。 */
export function readSystemBodySize(root?: HTMLElement): number | null {
  const doc = root?.ownerDocument ?? (typeof document === "undefined" ? undefined : document);
  const view = doc?.defaultView;
  if (!doc || !view) return null;
  let probe: HTMLElement | undefined;
  try {
    if (!view.CSS?.supports?.("font", SYSTEM_BODY_FONT)) return null;
    probe = doc.createElement("div");
    probe.style.cssText = `position: absolute; visibility: hidden; font: ${SYSTEM_BODY_FONT}`;
    (root ?? doc.body ?? doc.documentElement).append(probe);
    const size = Number.parseFloat(view.getComputedStyle(probe).fontSize);
    return Number.isFinite(size) && size > 0 ? size : null;
  } catch { return null; }
  finally { probe?.remove(); }
}

export function supportsSystemTextSize(root?: HTMLElement): boolean {
  return readSystemBodySize(root) !== null;
}
