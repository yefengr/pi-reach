import { join } from "node:path";

// 为不同文件系统的单组件限制留余量；按 UTF-8 字节计算而非 JS 字符数。
const MAX_FILE_NAME_BYTES = 240;
const FALLBACK_FILE_NAME = "attachment";
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)(?:\.|$)/iu;

export function localDateDirectory(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const codepoint of value) {
    const length = Buffer.byteLength(codepoint, "utf8");
    if (bytes + length > maximumBytes) break;
    result += codepoint;
    bytes += length;
  }
  return result;
}

function normalizeName(name: string): string {
  if (name === "" || name === "." || name === "..") return FALLBACK_FILE_NAME;
  const safe = name.replace(/[ .]+$/u, "_");
  return WINDOWS_DEVICE_NAME.test(safe.trimStart()) ? `_${safe}` : safe;
}

export function safeAttachmentFileName(original: string): string {
  let name = normalizeName(original.replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, "_"));
  if (Buffer.byteLength(name, "utf8") <= MAX_FILE_NAME_BYTES) return name;

  const extensionStart = name.lastIndexOf(".");
  if (extensionStart <= 0) name = truncateUtf8(name, MAX_FILE_NAME_BYTES);
  else {
    // 至少给主名留一个完整 codepoint；异常超长扩展也必须受同一字节上限约束。
    const extension = truncateUtf8(name.slice(extensionStart), MAX_FILE_NAME_BYTES - 4);
    const stem = truncateUtf8(name.slice(0, extensionStart), MAX_FILE_NAME_BYTES - Buffer.byteLength(extension));
    name = `${stem}${extension}`;
  }
  // 截断可能新产生设备名或尾部空格；重新归一化后仍须守住字节上限。
  return truncateUtf8(normalizeName(name), MAX_FILE_NAME_BYTES).replace(/[ .]+$/u, "_");
}

/** attachmentId 只来自服务端 randomUUID，不接受客户端提供的目录组件。 */
export function attachmentStoragePath(root: string, attachmentId: string, originalName: string, date: Date): string {
  return join(root, localDateDirectory(date), attachmentId, safeAttachmentFileName(originalName));
}
