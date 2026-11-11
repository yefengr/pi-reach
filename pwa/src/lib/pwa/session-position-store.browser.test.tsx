import { expect, test } from "vitest";
import { fromStoredPosition, SESSION_POSITION_MAX_ENTRIES, SESSION_POSITION_STORAGE_KEY, SessionPositionStore, toStoredPosition } from "./session-position-store";
import { captureTimelineViewportAnchor, restoreTimelineViewportAnchor } from "./timeline-viewport-anchor";

function mountList(rows = 30) {
  const list = document.createElement("div");
  Object.assign(list.style, { height: "200px", overflowY: "auto", position: "relative" });
  for (let index = 0; index < rows; index += 1) {
    const row = document.createElement("article");
    row.setAttribute("data-viewport-row", `row-${index}`);
    row.style.height = "60px";
    const text = document.createElement("p");
    Object.assign(text.style, { margin: "0", height: "60px" });
    text.textContent = `Row ${index}`;
    row.append(text);
    list.append(row);
  }
  document.body.append(list);
  return list;
}
const captured = (list: HTMLDivElement) => ({ following: false as const, anchor: captureTimelineViewportAnchor(list)! });

test("a reading position survives a reload: it is written to sessionStorage and re-anchors a freshly mounted list", () => {
  const list = mountList();
  list.scrollTop = 625;
  const first = new SessionPositionStore();
  first.set("live:device\u0000endpoint", captured(list));
  list.remove();

  // 重载：新的存储实例、新的列表元素，原 DOM 节点不复存在。
  const reloaded = new SessionPositionStore();
  const saved = reloaded.get("live:device\u0000endpoint");
  expect(saved).toEqual({ following: false, row: "row-10", block: 0, rowOffsetTop: -25, offsetTop: -25 });
  const next = mountList();
  expect(next.scrollTop).toBe(0);
  const position = fromStoredPosition(next, saved as Parameters<typeof fromStoredPosition>[1]);
  if (position.following) throw new Error("Expected an anchored position.");
  expect(restoreTimelineViewportAnchor(next, position.anchor)).toBe(true);
  expect(next.scrollTop).toBe(625);
  next.remove();
});

test("an anchor whose row has not loaded yet fails to restore so the caller can keep waiting", () => {
  const list = mountList(5);
  const position = fromStoredPosition(list, { following: false, row: "row-40", block: null, rowOffsetTop: 0, offsetTop: 0 });
  if (position.following) throw new Error("Expected an anchored position.");
  expect(restoreTimelineViewportAnchor(list, position.anchor)).toBe(false);
  expect(list.scrollTop).toBe(0);
  list.remove();
});

test("history entries keep their expanded count, and following positions stay following", () => {
  const list = mountList();
  list.scrollTop = 120;
  const store = new SessionPositionStore();
  store.set("history:1", { history: true, position: captured(list), shown: 190 });
  store.set("live:a", { following: true });
  const reloaded = new SessionPositionStore();
  expect(reloaded.get("history:1")).toEqual({ history: true, position: { following: false, row: "row-2", block: 0, rowOffsetTop: 0, offsetTop: 0 }, shown: 190 });
  expect(reloaded.get("live:a")).toEqual({ following: true });
  expect(toStoredPosition({ following: true })).toEqual({ following: true });
  list.remove();
});

test("positions in memory win over stored ones, and an anchor without a row key is not stored", () => {
  const list = mountList();
  list.scrollTop = 300;
  const store = new SessionPositionStore();
  const memory = captured(list);
  store.set("live:a", memory);
  expect(store.get("live:a")).toBe(memory);
  store.set("live:a", { following: false, anchor: { ...memory.anchor, rowLocator: null } });
  expect(new SessionPositionStore().get("live:a")).toBeUndefined();
  list.remove();
});

test("only the most recent entries are kept, malformed storage is ignored, and clearing blocks later writes", () => {
  const store = new SessionPositionStore();
  for (let index = 0; index <= SESSION_POSITION_MAX_ENTRIES; index += 1) store.set(`live:${index}`, { following: true });
  const reloaded = new SessionPositionStore();
  expect(reloaded.get("live:0")).toBeUndefined();
  expect(reloaded.get(`live:${SESSION_POSITION_MAX_ENTRIES}`)).toEqual({ following: true });

  window.sessionStorage.setItem(SESSION_POSITION_STORAGE_KEY, JSON.stringify([["live:x", { following: false, row: 3 }], ["live:y", { following: true }], "junk"]));
  const partial = new SessionPositionStore();
  expect(partial.get("live:x")).toBeUndefined();
  expect(partial.get("live:y")).toEqual({ following: true });
  window.sessionStorage.setItem(SESSION_POSITION_STORAGE_KEY, "{broken");
  expect(new SessionPositionStore().get("live:y")).toBeUndefined();

  partial.clear();
  expect(window.sessionStorage.getItem(SESSION_POSITION_STORAGE_KEY)).toBeNull();
  partial.set("live:z", { following: true });
  expect(window.sessionStorage.getItem(SESSION_POSITION_STORAGE_KEY)).toBeNull();
});
