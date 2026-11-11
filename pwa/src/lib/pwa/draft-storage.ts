/** 草稿文字按草稿键（电脑、Pi 实例与会话）保存在当前浏览器，页面被系统回收重载后仍可恢复。 */
export const DRAFT_STORAGE_KEY = "pi-reach-drafts";
/** 只保留最近更新的这些草稿；Pi 重启后旧实例的草稿键不再出现，靠数量与期限淘汰。 */
export const DRAFT_MAX_ENTRIES = 50;
export const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** 超过该长度的草稿不持久化，避免占满浏览器的本地存储配额。 */
export const DRAFT_MAX_CHARS = 100_000;

type StoredDraft = { text: string; at: number };
type StoredDrafts = Record<string, StoredDraft>;

/** 清除本地数据后到页面重载前不再写入，避免内存里的草稿被重新落盘。 */
let cleared = false;

function readStored(): StoredDrafts {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DRAFT_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, StoredDraft] => {
      const value = entry[1] as Partial<StoredDraft> | null;
      return !!value && typeof value.text === "string" && value.text !== "" && typeof value.at === "number" && Number.isFinite(value.at);
    }));
  } catch { return {}; }
}

/** 读取未过期的草稿；存储不可用或内容损坏时返回空。 */
export function readStoredDrafts(now = Date.now()): Record<string, string> {
  if (typeof window === "undefined") return {};
  return Object.fromEntries(Object.entries(readStored()).filter(([, draft]) => now - draft.at <= DRAFT_MAX_AGE_MS).map(([key, draft]) => [key, draft.text]));
}

/** 以当前草稿整体覆盖存储：空草稿删除，文字未变的保留原时间，超出数量时淘汰最久未更新的。 */
export function writeStoredDrafts(drafts: Readonly<Record<string, string>>, now = Date.now()): void {
  if (cleared || typeof window === "undefined") return;
  const previous = readStored();
  const entries = Object.entries(drafts)
    .filter(([key, text]) => key !== "" && text !== "" && text.length <= DRAFT_MAX_CHARS)
    .map(([key, text]): [string, StoredDraft] => [key, { text, at: previous[key]?.text === text ? previous[key].at : now }])
    .sort((left, right) => right[1].at - left[1].at)
    .slice(0, DRAFT_MAX_ENTRIES);
  try {
    if (entries.length === 0) window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    else window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* 存储不可用或超出配额时草稿只保留在本次运行内 */ }
}

/** 草稿键的首项是电脑的 deviceId；删除配对时据此移除该电脑的草稿。 */
export function draftBelongsToDevice(key: string, deviceId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && parsed[0] === deviceId;
  } catch { return false; }
}

export function clearStoredDrafts(): void {
  cleared = true;
  try { window.localStorage.removeItem(DRAFT_STORAGE_KEY); } catch { /* 存储不可用时无内容可清 */ }
}

export function resetDraftStorageForTest(): void {
  cleared = false;
}
