import { expect, test } from "vitest";
import { outsideTapSwallowed } from "./outside-tap-guard.js";

test("unrelated events are not marked and querying does not mutate them", () => {
  const event = new Event("pointerdown");
  const keys = Reflect.ownKeys(event);
  expect(outsideTapSwallowed(event)).toBe(false);
  expect(outsideTapSwallowed(event)).toBe(false);
  expect(Reflect.ownKeys(event)).toEqual(keys);
});
