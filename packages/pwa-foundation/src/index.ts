export { useFloatingSafeMiddlewares } from "./safe-area.js";
export { HAIRLINE_ATTRIBUTE, detectHairline, installHairlineDetection } from "./hairline.js";
export { PWA_MOTION_FALLBACK_MS, resolvePwaMotionDuration, readPwaMotionDuration, pwaStandardEasing, pwaContentEasing, pwaMotionShiftDisabled } from "./motion.js";
export type { PwaMotionDurationToken } from "./motion.js";
export { usePwaMotionDuration } from "./motion-react.js";
export { installPressFeedback, PRESS_ROW_DELAY_MS, PRESS_ROW_SLOP_PX, PRESS_ROW_TAP_MS } from "./press-feedback.js";
export { installOutsideTapGuard, outsideTapSwallowed } from "./outside-tap-guard.js";
export { readSystemBodySize, supportsSystemTextSize, textSizeForSystemBody } from "./text-size.js";
export type { PwaTextSize, PwaTextSizePreference } from "./text-size.js";
