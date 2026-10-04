export const FILE_TEXT_PREVIEW_BYTES = 1024 * 1024;
/** 限制 Markdown/代码渲染工作量，不把原件上限当作 DOM 上限。 */
export const FILE_TEXT_RENDER_CHARACTERS = 64 * 1024;
export const FILE_TEXT_RENDER_LINES = 1000;

export type FileTextPreview = { text: string; truncated: boolean };

export function textFilePreview(bytes: Uint8Array): FileTextPreview | null {
  const length = Math.min(bytes.byteLength, FILE_TEXT_PREVIEW_BYTES);
  const truncated = length < bytes.byteLength;
  let text: string;
  try {
    // 截断处未完成的 UTF-8 码点不输出，完整短文件仍必须通过 fatal 校验。
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length), { stream: truncated });
  } catch { return null; }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) return null;
  const lines = text.split("\n", FILE_TEXT_RENDER_LINES + 1);
  let end = Math.min(text.length, FILE_TEXT_RENDER_CHARACTERS);
  if (lines.length > FILE_TEXT_RENDER_LINES) end = Math.min(end, lines.slice(0, FILE_TEXT_RENDER_LINES).join("\n").length);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end -= 1;
  return { text: text.slice(0, end), truncated: truncated || end < text.length };
}

export function safeFileLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch { return undefined; }
}

/** 文件名不参与电脑端路径定位；仅净化浏览器保存名。 */
export function fileSaveName(value: string): string {
  const cleaned = value.replace(/[\p{Cc}<>:"/\\|?*]/gu, "_").replace(/[. ]+$/u, "");
  const base = cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(base);
  return `${reserved ? "_" : ""}${Array.from(base).slice(0, 240).join("")}`;
}
