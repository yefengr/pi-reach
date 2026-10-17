import type { ComposerAttachmentItem } from "@/components/pwa/attachment-cards";
import type { WireModel } from "@/lib/pi-reach/types";

export const UI_REVIEW_DRAFT = "请检查这段 Pi Reach 界面：保留中文长句与 English details，比较输入层次、菜单密度和复制反馈。";
export const UI_REVIEW_TEXT = "Pi Reach 真实组件对照：这是一段可以选择、复制的中文长文本。切换当前与候选时，内容保持一致；所有发送和模型选择仅在此页模拟，不会发送到 Pi。\nEnglish details: keep the same content, readable wrapping, keyboard focus and clipboard behavior in both variants.";
export const UI_REVIEW_CODE = 'const review = {\n  project: "Pi Reach",\n  mode: "local-demo",\n  note: "仅页面内演示，不连接 Relay 或 Pi",\n};\nconsole.log(review.mode);';

export const UI_REVIEW_MODELS: WireModel[] = Array.from({ length: 14 }, (_, index) => ({
  id: index === 0 ? "model-standard" : `model-review-${index + 1}`,
  name: index === 0 ? "model-standard" : index === 1 ? "长名称模型 · 保留完整说明与 English context for narrow screens" : `model-review-${index + 1} · 界面对照演示`,
  provider: "demo",
  reasoning: true,
  context_window: 128_000,
  vision: false,
}));

/** 附件卡片对照：同一批内容覆盖草稿、准备、上传、暂停、完成、失败六种状态。 */
export const UI_REVIEW_ATTACHMENTS: ComposerAttachmentItem[] = [
  { id: "att-draft", fileName: "界面稿件-最终版-v3.png", byteLength: 1_480_320, status: "draft" },
  { id: "att-preparing", fileName: "会议记录-2026-10-17.md", byteLength: 24_576, status: "preparing" },
  { id: "att-uploading", fileName: "长文件名示例-季度复盘与下一步计划-final.pdf", byteLength: 8_912_896, status: "uploading", receivedBytes: 3_355_443 },
  { id: "att-paused", fileName: "数据导出.csv", byteLength: 512_000, status: "paused", receivedBytes: 204_800 },
  { id: "att-complete", fileName: "screenshot.png", byteLength: 655_360, status: "complete" },
  { id: "att-failed", fileName: "离线时的上传.zip", byteLength: 1_048_576, status: "failed", errorText: "连接中断，未上传完成。" },
];
