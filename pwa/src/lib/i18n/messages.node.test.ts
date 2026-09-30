import { expect, test } from "vitest";
import { localizeFeedback, safeFeedbackCatalog } from "@/lib/pwa/feedback-messages";
import { en } from "./messages/en";
import { zh } from "./messages/zh";

function leaves(value: unknown, path: string[] = []): Array<[string, unknown]> {
  if (typeof value === "string" || typeof value === "function") return [[path.join("."), value]];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leaves(child, [...path, key]));
}

test("the Chinese dictionary covers every English entry with non-empty text of the same kind", () => {
  const english = new Map(leaves(en));
  const chinese = new Map(leaves(zh));
  expect([...chinese.keys()].sort()).toEqual([...english.keys()].sort());
  for (const [key, value] of chinese) {
    expect(typeof value, key).toBe(typeof english.get(key));
    if (typeof value === "string") expect(value.trim(), key).not.toBe("");
  }
});

test("every safe feedback message has a Chinese translation", () => {
  for (const message of safeFeedbackCatalog()) {
    expect(localizeFeedback(message, "zh-CN"), message).not.toBe(message);
    expect(localizeFeedback(message, "en")).toBe(message);
  }
});
