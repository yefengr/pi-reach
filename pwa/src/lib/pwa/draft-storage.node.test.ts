import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearStoredDrafts, DRAFT_MAX_AGE_MS, DRAFT_MAX_CHARS, DRAFT_MAX_ENTRIES, DRAFT_STORAGE_KEY, draftBelongsToDevice, readStoredDrafts, resetDraftStorageForTest, writeStoredDrafts } from "./draft-storage";

const key = (device: string, session = "session-1") => JSON.stringify([device, "endpoint", "runtime", session]);

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => { values.set(name, value); },
      removeItem: (name: string) => { values.delete(name); },
    },
  });
  resetDraftStorageForTest();
});
afterEach(() => { vi.unstubAllGlobals(); });

test("drafts round-trip, and an emptied draft is removed", () => {
  writeStoredDrafts({ [key("a")]: "half written", [key("b")]: "second" }, 1000);
  expect(readStoredDrafts(2000)).toEqual({ [key("a")]: "half written", [key("b")]: "second" });
  writeStoredDrafts({ [key("a")]: "", [key("b")]: "second" }, 3000);
  expect(readStoredDrafts(4000)).toEqual({ [key("b")]: "second" });
  writeStoredDrafts({}, 5000);
  expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
});

test("an unchanged draft keeps its time and expires from it; an edited draft is refreshed", () => {
  writeStoredDrafts({ [key("a")]: "old", [key("b")]: "edited v1" }, 0);
  writeStoredDrafts({ [key("a")]: "old", [key("b")]: "edited v2" }, DRAFT_MAX_AGE_MS);
  expect(readStoredDrafts(DRAFT_MAX_AGE_MS + 1)).toEqual({ [key("b")]: "edited v2" });
});

test("only the most recently updated drafts are kept, and oversized drafts are not stored", () => {
  const many = Object.fromEntries(Array.from({ length: DRAFT_MAX_ENTRIES }, (_, index) => [key("a", `old-${index}`), "text"]));
  writeStoredDrafts(many, 0);
  writeStoredDrafts({ ...many, [key("a", "fresh")]: "newest", [key("a", "huge")]: "x".repeat(DRAFT_MAX_CHARS + 1) }, 10);
  const stored = readStoredDrafts(20);
  expect(Object.keys(stored)).toHaveLength(DRAFT_MAX_ENTRIES);
  expect(stored[key("a", "fresh")]).toBe("newest");
  expect(stored[key("a", "huge")]).toBeUndefined();
});

test("malformed storage reads as empty and unusable storage is tolerated", () => {
  window.localStorage.setItem(DRAFT_STORAGE_KEY, "{not json");
  expect(readStoredDrafts()).toEqual({});
  window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ [key("a")]: { text: 5, at: "x" }, [key("b")]: { text: "ok", at: Date.now() }, [key("c")]: null }));
  expect(readStoredDrafts()).toEqual({ [key("b")]: "ok" });
  window.localStorage.setItem = () => { throw new Error("quota"); };
  expect(() => writeStoredDrafts({ [key("a")]: "text" })).not.toThrow();
});

test("clearing removes stored drafts and blocks later writes until the page reloads", () => {
  writeStoredDrafts({ [key("a")]: "secret" }, 0);
  clearStoredDrafts();
  expect(readStoredDrafts(1)).toEqual({});
  writeStoredDrafts({ [key("a")]: "secret" }, 2);
  expect(readStoredDrafts(3)).toEqual({});
});

test("draft keys are matched to their computer by device id only", () => {
  expect(draftBelongsToDevice(key("device-a"), "device-a")).toBe(true);
  expect(draftBelongsToDevice(key("device-b"), "device-a")).toBe(false);
  expect(draftBelongsToDevice("", "device-a")).toBe(false);
  expect(draftBelongsToDevice("not json", "device-a")).toBe(false);
});
