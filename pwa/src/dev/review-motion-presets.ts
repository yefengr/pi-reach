import type { PwaMotionDurationToken } from "@/lib/ui/motion-duration";

/**
 * 展厅的动效对比项，见 docs/adr/20261031-motion-layers-ios-spring.md。
 * 旧规范以内联 token 完整还原改动前的取值，用于与现行 iOS 弹簧对照。
 */
export type ReviewMotionPresetId = "current" | "previous";
export type ReviewShiftToken = "--pwa-overlay-shift" | "--pwa-message-shift" | "--pwa-collapse-shift";
export type ReviewMotionPreset = {
  label: string;
  durations: Partial<Record<PwaMotionDurationToken, number>>;
  shifts: Partial<Record<ReviewShiftToken, number>>;
  easeContent?: string;
  easeSettle?: string;
  /** 参数对照表的曲线说明。 */
  curve: string;
};

export const REVIEW_SHIFT_TOKENS: readonly ReviewShiftToken[] = ["--pwa-overlay-shift", "--pwa-message-shift", "--pwa-collapse-shift"];
export const REVIEW_CURRENT_CURVE = "iOS 弹簧（无回弹）";

export const REVIEW_MOTION_PRESETS: Record<Exclude<ReviewMotionPresetId, "current">, ReviewMotionPreset> = {
  previous: {
    label: "旧规范",
    durations: {
      "--pwa-duration-message-in": 160, "--pwa-duration-collapse-in": 180, "--pwa-duration-collapse-out": 140, "--pwa-duration-collapse-settle": 320,
      "--pwa-duration-toast": 180, "--pwa-duration-toast-out": 140, "--pwa-duration-modal-in": 180, "--pwa-duration-modal-out": 140,
      "--pwa-duration-sidebar": 220, "--pwa-duration-image-in": 260, "--pwa-duration-image-out": 220, "--pwa-duration-content": 240,
    },
    shifts: { "--pwa-overlay-shift": 8, "--pwa-message-shift": 6, "--pwa-collapse-shift": 4 },
    easeContent: "cubic-bezier(0.2, 0, 0, 1)",
    easeSettle: "cubic-bezier(0.4, 0, 0.2, 1)",
    curve: "进入 (0, 0, 0, 1)／其余 (0.2, 0, 0, 1)",
  },
};

export const REVIEW_MOTION_OPTIONS: { value: ReviewMotionPresetId; label: string }[] = [
  { value: "current", label: "现行 · iOS 弹簧" },
  ...Object.entries(REVIEW_MOTION_PRESETS).map(([value, preset]) => ({ value: value as ReviewMotionPresetId, label: preset.label })),
];
