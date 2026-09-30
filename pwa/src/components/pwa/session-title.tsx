import type { PwaEndpointRecord } from "@/lib/pwa/db";
import { getMessages } from "@/lib/i18n";

/** Extension 在会话未命名时写入的默认名；PWA 只把它当作「未命名」并按界面语言显示。 */
const EXTENSION_UNTITLED_SESSION_NAME = "Untitled session";

export function displayPi(endpoint: Pick<PwaEndpointRecord, "name">): string {
  const name = endpoint.name?.trim();
  // 扩展默认名与空缺都显示当前语言的「未命名会话」；真实用户命名（含其他英文名）原样显示。
  if (!name || name === EXTENSION_UNTITLED_SESSION_NAME) return getMessages().common.untitledSession;
  return name;
}
