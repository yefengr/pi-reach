import { expect, test } from "vitest";
import { formatViewportDebugLines, formatViewportDebugReport, VIEWPORT_DEBUG_REPORT_FORMAT, VIEWPORT_FRAME_FIELDS,
  ViewportFrameRecorder, type ViewportFrameMeasure } from "./viewport-debug";

const measure: ViewportFrameMeasure = {
  vvTop: 120, vvHeight: 480.5, vvPageTop: 120, vvScale: 1, scrollY: 0, innerHeight: 844, docHeight: 844, keyboard: true,
  cssTop: 120, cssHeight: 480.5, shellTop: 120, shellHeight: 480.5, titleTop: 100, composerTop: 520, listTop: 160,
  listScrollTop: 900, listScrollHeight: 1400, listClientHeight: 300, focus: "text",
};

test("recorder keeps a bounded ring of numbered frames and marks relative to the last clear", () => {
  let now = 1000;
  const recorder = new ViewportFrameRecorder(() => now, 3);
  for (let index = 0; index < 5; index += 1) {
    now += 16.66;
    recorder.record(measure);
  }
  recorder.mark("focusout");
  const { frames, marks } = recorder.snapshot();
  expect(frames.map((frame) => frame.frame)).toEqual([3, 4, 5]);
  expect(frames[2]!.t).toBe(83.3);
  expect(marks).toEqual([{ frame: 5, t: 83.3, kind: "focusout" }]);

  now = 5000;
  recorder.clear();
  expect(recorder.snapshot()).toEqual({ frames: [], marks: [] });
  now = 5010;
  expect(recorder.record(measure)).toMatchObject({ frame: 1, t: 10 });
});

test("overlay lines lead with the frame number and show raw element positions", () => {
  const lines = formatViewportDebugLines({ ...measure, frame: 42, t: 700, vvHeight: null });
  expect(lines[0]).toBe("#42  t 700");
  expect(lines[1]).toBe("vv top 120 h - pg 120");
  expect(lines).toContain("title 100 comp 520");
  expect(lines.at(-1)).toBe("focus text");
});

test("report stores frames as columns and carries only the provided whitelisted sections", () => {
  const recorder = new ViewportFrameRecorder(() => 0);
  recorder.record(measure);
  const report = JSON.parse(formatViewportDebugReport({ ...recorder.snapshot(), timeline: [], environment: { pwaVersion: "0.0.0" } }));
  expect(Object.keys(report)).toEqual(["format", "environment", "frames", "marks", "timeline"]);
  expect(report.format).toBe(VIEWPORT_DEBUG_REPORT_FORMAT);
  expect(report.frames.columns).toEqual([...VIEWPORT_FRAME_FIELDS]);
  expect(report.frames.rows).toEqual([VIEWPORT_FRAME_FIELDS.map((field) => ({ ...measure, frame: 1, t: 0 })[field])]);
});
