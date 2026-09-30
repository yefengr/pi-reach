import { useSyncExternalStore } from "react";
import { en, type Messages } from "./messages/en";
import { zh } from "./messages/zh";
import { getLanguageState, getLocale, setLanguagePreference, subscribeLanguage, type LanguagePreference, type Locale } from "./locale";

export type { LanguagePreference, Locale, Messages };
export { setLanguagePreference };

const dictionaries: Record<Locale, Messages> = { en, "zh-CN": zh };

export function messagesFor(locale: Locale): Messages {
  return dictionaries[locale];
}

/** 非 React 代码按调用时的语言取文案；组件内使用 useI18n，以便切换语言后重新渲染。 */
export function getMessages(): Messages {
  return messagesFor(getLocale());
}

export type Formatters = Readonly<{
  /** 时刻，如 17:43 */
  time: (timestamp: number) => string;
  /** 日期与时刻 */
  dateTime: (timestamp: number) => string;
  number: (value: number) => string;
  /** 本地历史行的时间：今天显示时刻，昨天显示「昨天」，更早显示月日（跨年加年份）。 */
  historyTime: (timestamp: number, now?: number) => string;
}>;

const formatterCache = new Map<Locale, Formatters>();

export function formattersFor(locale: Locale): Formatters {
  const cached = formatterCache.get(locale);
  if (cached) return cached;
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const number = new Intl.NumberFormat(locale);
  const monthDay = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
  const yearMonthDay = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" });
  const formatters: Formatters = {
    time: (timestamp) => time.format(timestamp),
    dateTime: (timestamp) => dateTime.format(timestamp),
    number: (value) => number.format(value),
    historyTime: (timestamp, now = Date.now()) => {
      const day = new Date(timestamp);
      const today = new Date(now);
      const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const startOfYesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
      if (timestamp >= startOfToday) return time.format(timestamp);
      if (timestamp >= startOfYesterday) return messagesFor(locale).navigation.yesterday;
      return day.getFullYear() === today.getFullYear() ? monthDay.format(timestamp) : yearMonthDay.format(timestamp);
    },
  };
  formatterCache.set(locale, formatters);
  return formatters;
}

export type I18n = Readonly<{
  locale: Locale;
  preference: LanguagePreference;
  t: Messages;
  format: Formatters;
}>;

export function useI18n(): I18n {
  const state = useSyncExternalStore(subscribeLanguage, getLanguageState, getLanguageState);
  return { locale: state.locale, preference: state.preference, t: messagesFor(state.locale), format: formattersFor(state.locale) };
}
