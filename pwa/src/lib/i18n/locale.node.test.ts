import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getLanguageState, LANGUAGE_STORAGE_KEY, resetLanguageStateForTest, resolveBrowserLocale, resolveLocale, setLanguagePreference, subscribeLanguage } from "./locale";

describe("resolveBrowserLocale", () => {
  test("uses the first Chinese or English entry in order", () => {
    expect(resolveBrowserLocale(["fr-FR", "zh-TW", "en-US"])).toBe("zh-CN");
    expect(resolveBrowserLocale(["de", "en-GB", "zh-CN"])).toBe("en");
    expect(resolveBrowserLocale(["zh-Hant-HK"])).toBe("zh-CN");
    expect(resolveBrowserLocale(["ZH-sg"])).toBe("zh-CN");
  });

  test("falls back to English for other or missing languages", () => {
    expect(resolveBrowserLocale(["ja-JP", "fr"])).toBe("en");
    expect(resolveBrowserLocale([])).toBe("en");
    expect(resolveBrowserLocale(undefined)).toBe("en");
  });

  test("a manual choice overrides the browser languages", () => {
    expect(resolveLocale("zh", ["en-US"])).toBe("zh-CN");
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale("system", ["zh-CN"])).toBe("zh-CN");
  });
});

describe("language preference store", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    });
    vi.stubGlobal("navigator", { languages: ["zh-CN", "en"], language: "zh-CN" });
    resetLanguageStateForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetLanguageStateForTest();
  });

  test("follows the browser until a manual choice is stored, and clears it when following again", () => {
    expect(getLanguageState()).toEqual({ preference: "system", locale: "zh-CN" });
    const listener = vi.fn();
    const unsubscribe = subscribeLanguage(listener);

    setLanguagePreference("en");
    expect(storage.get(LANGUAGE_STORAGE_KEY)).toBe("en");
    expect(getLanguageState()).toEqual({ preference: "en", locale: "en" });

    setLanguagePreference("system");
    expect(storage.has(LANGUAGE_STORAGE_KEY)).toBe(false);
    expect(getLanguageState()).toEqual({ preference: "system", locale: "zh-CN" });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  test("restores a stored choice and ignores unknown stored values", () => {
    storage.set(LANGUAGE_STORAGE_KEY, "en");
    expect(getLanguageState().locale).toBe("en");
    resetLanguageStateForTest();
    storage.set(LANGUAGE_STORAGE_KEY, "fr");
    expect(getLanguageState()).toEqual({ preference: "system", locale: "zh-CN" });
  });

  test("keeps working when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });
    resetLanguageStateForTest();
    expect(getLanguageState().preference).toBe("system");
    setLanguagePreference("en");
    expect(getLanguageState().locale).toBe("en");
  });
});
