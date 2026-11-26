import { expect, test } from "vitest";
import { PRESS_ROW_DELAY_MS, PRESS_ROW_SLOP_PX, PRESS_ROW_TAP_MS, installPressFeedback } from "./press-feedback.js";

test("press constants preserve delayed row and short tap timing without browser globals at import", () => {
  expect([PRESS_ROW_DELAY_MS, PRESS_ROW_SLOP_PX, PRESS_ROW_TAP_MS]).toEqual([100, 10, 120]);
  expect(typeof installPressFeedback).toBe("function");
});
