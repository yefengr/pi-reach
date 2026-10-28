import { describe, expect, test } from "vitest";
import { ReplyContinuity, type ReplyProbe } from "./timeline-viewport-continuity";

function fixture() {
  let row: ReturnType<ReplyProbe["sample"]> = { height: 100, streaming: true };
  const geometry = { height: 500, bottom: 200, compensation: 0 };
  const continuity = new ReplyContinuity({ sample: () => row }, geometry);
  return { continuity, geometry, row: (value: typeof row) => { row = value; } };
}

describe("ReplyContinuity", () => {
  test("only the tracked row explains growth, including same-key formal takeover", () => {
    const f = fixture();
    f.row({ height: 130, streaming: true });
    expect(f.continuity.update({ ...f.geometry, height: 530, bottom: 230 })).toBe(true);
    f.row({ height: 150, streaming: false });
    expect(f.continuity.update({ ...f.geometry, height: 550, bottom: 250 })).toBe(true);
    expect(f.continuity.retain(true)).toBe(true);
    expect(f.continuity.retain(false)).toBe(false);
  });
  test.each([10, 1000])("an unrelated row's %ipx growth invalidates the probe", height => {
    const f = fixture();
    expect(f.continuity.update({ ...f.geometry, height: 500 + height, bottom: 200 + height })).toBe(false);
  });
  test("real viewport changes invalidate even when the reply grows", () => {
    const f = fixture();
    f.row({ height: 130, streaming: true });
    expect(f.continuity.update({ ...f.geometry, height: 530, bottom: 250 })).toBe(false);
  });
  test("sizing owns footer changes but does not exempt the next content mutation", () => {
    const f = fixture();
    expect(f.continuity.update({ ...f.geometry, bottom: 220 }, true)).toBe(true);
    expect(f.continuity.update({ ...f.geometry, height: 520, bottom: 240 })).toBe(false);
  });
  test("temporary compensation is not natural content growth", () => {
    const f = fixture();
    expect(f.continuity.update({ ...f.geometry, height: 520, bottom: 220, compensation: 20 })).toBe(true);
  });
  test("streaming may retain a stationary probe but disconnection invalidates it", () => {
    const f = fixture();
    expect(f.continuity.retain(false)).toBe(true);
    f.row(null);
    expect(f.continuity.update(f.geometry, true)).toBe(false);
  });
});
