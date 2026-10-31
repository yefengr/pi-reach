import type { PwaMotionDurationToken } from "@/lib/ui/motion-duration";

/**
 * 「内容与空间变化」层的对比参数，见 docs/plans/active/20261031-motion-content-space.md。
 * 只在 DEV 展厅生效；操作反馈层（按压、菜单、复制反馈）与未列出的 token 保持主题值。
 */
export type ReviewMotionPresetId = "current" | "moderate" | "relaxed";
export type ReviewShiftToken = "--pwa-overlay-shift" | "--pwa-message-shift" | "--pwa-collapse-shift";
export type ReviewMotionPreset = {
  label: string;
  durations: Partial<Record<PwaMotionDurationToken, number>>;
  shifts: Record<ReviewShiftToken, number>;
  /** 只在内容与空间变化的范围内改写（见 ui-states.css 的 data-review-motion 规则）。 */
  easeEnter: string;
  easeStandard: string;
};

export const REVIEW_SHIFT_TOKENS: readonly ReviewShiftToken[] = ["--pwa-overlay-shift", "--pwa-message-shift", "--pwa-collapse-shift"];
export const REVIEW_EASE_VARIABLES = ["--review-ease-enter", "--review-ease-standard"] as const;

export const REVIEW_MOTION_PRESETS: Record<Exclude<ReviewMotionPresetId, "current">, ReviewMotionPreset> = {
  moderate: {
    label: "候选 A · 适中",
    durations: {
      "--pwa-duration-message-in": 240,
      "--pwa-duration-collapse-in": 240, "--pwa-duration-collapse-out": 200,
      "--pwa-duration-toast": 240, "--pwa-duration-toast-out": 180,
      "--pwa-duration-modal-in": 240, "--pwa-duration-modal-out": 180,
    },
    shifts: { "--pwa-overlay-shift": 10, "--pwa-message-shift": 8, "--pwa-collapse-shift": 6 },
    easeEnter: "cubic-bezier(0.2, 0, 0, 1)",
    easeStandard: "cubic-bezier(0.2, 0, 0, 1)",
  },
  relaxed: {
    label: "候选 B · 舒缓",
    durations: {
      "--pwa-duration-message-in": 300,
      "--pwa-duration-collapse-in": 300, "--pwa-duration-collapse-out": 240,
      "--pwa-duration-toast": 300, "--pwa-duration-toast-out": 220,
      "--pwa-duration-modal-in": 280, "--pwa-duration-modal-out": 200,
    },
    shifts: { "--pwa-overlay-shift": 12, "--pwa-message-shift": 12, "--pwa-collapse-shift": 8 },
    easeEnter: "cubic-bezier(0.2, 0, 0.2, 1)",
    easeStandard: "cubic-bezier(0.2, 0, 0.2, 1)",
  },
};

export const REVIEW_MOTION_OPTIONS: { value: ReviewMotionPresetId; label: string }[] = [
  { value: "current", label: "现行规范" },
  ...Object.entries(REVIEW_MOTION_PRESETS).map(([value, preset]) => ({ value: value as ReviewMotionPresetId, label: preset.label })),
];
