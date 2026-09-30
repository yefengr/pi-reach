import { afterEach, expect, test } from "vitest";
import { setLanguagePreference } from "@/lib/i18n";
import { resetLanguageStateForTest } from "@/lib/i18n/locale";
import { displayPi } from "./session-title";

afterEach(() => {
  setLanguagePreference("system");
  resetLanguageStateForTest();
});

test("uses the endpoint session name and a stable untitled fallback", () => {
  expect(displayPi({ name: "  Plan remote workspace  " })).toBe("Plan remote workspace");
  expect(displayPi({ name: "   " })).toBe("Untitled session");
  expect(displayPi({})).toBe("Untitled session");
});

test("localizes the extension default name while real names stay unchanged", () => {
  expect(displayPi({ name: "Untitled session" })).toBe("Untitled session");
  setLanguagePreference("zh");
  expect(displayPi({ name: "Untitled session" })).toBe("未命名会话");
  expect(displayPi({ name: "   " })).toBe("未命名会话");
  expect(displayPi({})).toBe("未命名会话");
  expect(displayPi({ name: "  Plan remote workspace  " })).toBe("Plan remote workspace");
  setLanguagePreference("en");
  expect(displayPi({ name: "Untitled session" })).toBe("Untitled session");
});
