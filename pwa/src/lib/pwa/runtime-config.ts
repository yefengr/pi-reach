export const DEFAULT_RELAY_META_NAME = "pi-reach-default-relay-url";

/** 部署入口只公开地址；拒绝 URL 解析器会容忍的空白、凭据和注入字符。 */
export function validateDefaultRelayUrl(value: string): string {
  if (!/^(?:https?|wss?):\/\/[A-Za-z0-9:/?@!$&'()*+,;=._~%\[\]-]+$/.test(value) || /%(?![\da-f]{2})/i.test(value)) {
    throw new Error("invalid_default_relay_url");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid_default_relay_url"); }
  const authority = value.split("/")[2].split("?")[0];
  if (!url.hostname || url.username || url.password || url.hash || authority.includes("@")) {
    throw new Error("invalid_default_relay_url");
  }
  const authorityMatch = /^(\[[\da-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]+))?$/i.exec(authority);
  if (!authorityMatch) throw new Error("invalid_default_relay_url");
  const host = authorityMatch[1];
  if (!host.startsWith("[")) {
    const labels = host.replace(/\.$/, "").split(".");
    if (labels.some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
      throw new Error("invalid_default_relay_url");
    }
    const numericHost = /^[0-9.]+$/.test(host.replace(/\.$/, ""));
    // 与容器相同：拒绝 WHATWG 会按八进制解释的前导零 IPv4 段。
    if (numericHost && (labels.length !== 4 || labels.some((label) => Number(label) > 255 || (label.length > 1 && label.startsWith("0"))))) {
      throw new Error("invalid_default_relay_url");
    }
  }
  // 保留自托管路径与 query，不使用 URL.toString() 改写管理员提供的地址。
  return value;
}

export function readDefaultRelayUrl(source: Pick<Document, "querySelectorAll"> = document): string {
  const entries = source.querySelectorAll(`meta[name="${DEFAULT_RELAY_META_NAME}"]`);
  if (entries.length !== 1) throw new Error("missing_or_duplicate_default_relay_metadata");
  return validateDefaultRelayUrl(entries[0].getAttribute("content") ?? "");
}
