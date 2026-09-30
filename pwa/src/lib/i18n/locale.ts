// 界面语言：偏好只保存在当前浏览器；「跟随浏览器」时不写存储。
export const LANGUAGE_STORAGE_KEY = "pi-reach-language";

export type Locale = "zh-CN" | "en";
export type LanguagePreference = "system" | "zh" | "en";

/** 按 navigator.languages 顺序取第一个中文或英文条目；任何中文区域都显示简体中文，其余显示英文。 */
export function resolveBrowserLocale(languages: readonly string[] | undefined): Locale {
  for (const language of languages ?? []) {
    const primary = language.toLowerCase().split("-")[0];
    if (primary === "zh") return "zh-CN";
    if (primary === "en") return "en";
  }
  return "en";
}

export function resolveLocale(preference: LanguagePreference, languages: readonly string[] | undefined): Locale {
  if (preference === "zh") return "zh-CN";
  if (preference === "en") return "en";
  return resolveBrowserLocale(languages);
}

function browserLanguages(): readonly string[] | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : undefined;
}

function readPreference(): LanguagePreference {
  try {
    const stored = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
    return stored === "zh" || stored === "en" ? stored : "system";
  } catch {
    return "system";
  }
}

function writePreference(preference: LanguagePreference): void {
  try {
    if (preference === "system") globalThis.localStorage?.removeItem(LANGUAGE_STORAGE_KEY);
    else globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    // 存储不可用时本次访问仍按选择显示。
  }
}

type LanguageState = Readonly<{ preference: LanguagePreference; locale: Locale }>;

let state: LanguageState | null = null;
const listeners = new Set<() => void>();

function applyDocumentLanguage(locale: Locale): void {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

function computeState(preference: LanguagePreference): LanguageState {
  return { preference, locale: resolveLocale(preference, browserLanguages()) };
}

function publish(next: LanguageState): void {
  const changed = state === null || state.locale !== next.locale || state.preference !== next.preference;
  state = next;
  applyDocumentLanguage(next.locale);
  if (changed) for (const listener of listeners) listener();
}

export function getLanguageState(): LanguageState {
  if (state === null) publish(computeState(readPreference()));
  return state!;
}

export function getLocale(): Locale {
  return getLanguageState().locale;
}

export function setLanguagePreference(preference: LanguagePreference): void {
  writePreference(preference);
  publish(computeState(preference));
}

function onBrowserLanguageChange(): void {
  const current = getLanguageState();
  if (current.preference === "system") publish(computeState("system"));
}

export function subscribeLanguage(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("languagechange", onBrowserLanguageChange);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("languagechange", onBrowserLanguageChange);
  };
}

/** 仅供测试：丢弃缓存状态，下次读取时重新解析存储与浏览器语言。 */
export function resetLanguageStateForTest(): void {
  state = null;
}
