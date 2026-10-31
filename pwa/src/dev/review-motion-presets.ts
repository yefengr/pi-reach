import type { PwaMotionDurationToken } from "@/lib/ui/motion-duration";
import type { PwaMotionProfile } from "@/lib/ui/motion-profile";

/**
 * 展厅的动效对比项，见 docs/plans/active/20261031-motion-content-space.md。
 * P2／P3 复用主题里的评估期风格（根节点 data-pwa-motion，不写入存储）；旧规范以内联 token 完整还原改动前的取值。
 */
export type ReviewMotionPresetId = "current" | "symmetric" | "decelerate" | "previous";
export type ReviewShiftToken = "--pwa-overlay-shift" | "--pwa-message-shift" | "--pwa-collapse-shift";
export type ReviewMotionPreset = {
  label: string;
  /** 主题中的评估期风格；缺省时保持默认弹簧。 */
  profile?: Exclude<PwaMotionProfile, "spring">;
  durations: Partial<Record<PwaMotionDurationToken, number>>;
  shifts: Partial<Record<ReviewShiftToken, number>>;
  easeContent?: string;
  easeSettle?: string;
  /** 参数对照表的曲线说明。 */
  curve: string;
};

export const REVIEW_SHIFT_TOKENS: readonly ReviewShiftToken[] = ["--pwa-overlay-shift", "--pwa-message-shift", "--pwa-collapse-shift"];
export const REVIEW_CURRENT_CURVE = "iOS 弹簧（无回弹）";
const PROFILE_DURATIONS: Partial<Record<PwaMotionDurationToken, number>> = {
  "--pwa-duration-message-in": 300, "--pwa-duration-collapse-in": 300, "--pwa-duration-collapse-out": 240, "--pwa-duration-collapse-settle": 320,
  "--pwa-duration-toast": 300, "--pwa-duration-toast-out": 220, "--pwa-duration-modal-in": 280, "--pwa-duration-modal-out": 200,
  "--pwa-duration-sidebar": 220, "--pwa-duration-image-in": 260, "--pwa-duration-image-out": 220, "--pwa-duration-content": 240,
};

export const REVIEW_MOTION_PRESETS: Record<Exclude<ReviewMotionPresetId, "current">, ReviewMotionPreset> = {
  symmetric: { label: "P2 舒缓", profile: "symmetric", durations: {}, shifts: {}, curve: "(0.2, 0, 0.2, 1)" },
  decelerate: { label: "P3 减速", profile: "decelerate", durations: {}, shifts: {}, curve: "(0.2, 0, 0, 1)" },
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

/** 参数对照表中各项的实际时长：评估期风格取主题值，旧规范取内联值。 */
export function reviewPresetDuration(id: Exclude<ReviewMotionPresetId, "current">, token: PwaMotionDurationToken): number | undefined {
  const preset = REVIEW_MOTION_PRESETS[id];
  return preset.durations[token] ?? (preset.profile ? PROFILE_DURATIONS[token] : undefined);
}

export const REVIEW_MOTION_OPTIONS: { value: ReviewMotionPresetId; label: string }[] = [
  { value: "current", label: "P4 iOS 弹簧（默认）" },
  ...Object.entries(REVIEW_MOTION_PRESETS).map(([value, preset]) => ({ value: value as ReviewMotionPresetId, label: preset.label })),
];
