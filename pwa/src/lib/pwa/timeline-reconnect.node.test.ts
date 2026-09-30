import { expect, test } from "vitest";
import { TIMELINE_RECENT_LIMIT } from "./timeline-reconnect";

test("uses the bounded reconnect history window", () => {
  expect(TIMELINE_RECENT_LIMIT).toBe(30);
});
