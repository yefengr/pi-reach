import { expect, test } from "vitest";
import { formatViewportDebugLines, formatViewportDebugReport, VIEWPORT_DEBUG_REPORT_FORMAT, VIEWPORT_FRAME_FIELDS,
  ViewportFrameRecorder, type ViewportFrameMeasure } from "./viewport-debug";

const measure: ViewportFrameMeasure = {
  vvTop: 120, vvHeight: 480.5, vvPageTop: 120, vvScale: 1, scrollY: 0, innerHeight: 844, docHeight: 844, keyboard: true, motion: "opening",
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
  expect(lines).toContain("kb 1 opening css 120/480.5");
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

test("event geometry survives frame eviction and is copied instead of retaining mutable input", () => {
  let now = 100;
  const recorder = new ViewportFrameRecorder(() => now, 2);
  const snapshot = {
    vvHeight: 812, vvTop: 0, vvScale: 1, innerHeight: 812, docHeight: 812,
    rootBoxHeight: 812, bodyBoxHeight: 812, shellHeight: 812, scrollY: 0,
    documentLocked: true, documentLockHeight: 812, compact: null, composerBudget: null,
    paddingTop: 24, paddingBottom: 88, composerPaddingBottom: 8, focus: "none" as const,
  };
  const controller = {
    reason: "compensated" as const, appHeight: 874, unfocusedInset: 0, unfocusedOcclusion: 0,
    previousHeight: 812, lastHeight: 812, viewportHeight: 812, adjusted: true,
    restored: false, restoreThreshold: 873, closing: false, closingTarget: null,
  };
  now = 150;
  recorder.mark("vv-resize", snapshot, controller);
  snapshot.rootBoxHeight = 1;
  controller.appHeight = 1;
  for (let index = 0; index < 5; index += 1) {
    now += 20;
    recorder.record(measure);
  }
  const data = recorder.snapshot();
  expect(data.frames.map(frame => frame.frame)).toEqual([4, 5]);
  expect(data.marks[0]).toMatchObject({ frame: 0, t: 50, kind: "vv-resize",
    snapshot: { vvHeight: 812, rootBoxHeight: 812 }, controller: { appHeight: 874, restored: false } });
  recorder.clear();
  expect(recorder.snapshot()).toEqual({ frames: [], marks: [] });
});

test("event records whitelist nested fields and remain bounded independently of frames", () => {
  const recorder = new ViewportFrameRecorder(() => 0);
  const snapshot = {
    vvHeight: 812, vvTop: 0, vvScale: 1, innerHeight: 812, docHeight: 812,
    rootBoxHeight: 812, bodyBoxHeight: 812, shellHeight: 812, scrollY: 0,
    documentLocked: true, documentLockHeight: 812, compact: null, composerBudget: null,
    paddingTop: 24, paddingBottom: 88, composerPaddingBottom: 8, focus: "none" as const,
    documentLockBypassed: true, messageBody: "unrelated-private-field",
  };
  const controller = {
    reason: "compensated" as const, appHeight: 874, unfocusedInset: 0, unfocusedOcclusion: 0,
    previousHeight: 812, lastHeight: 812, viewportHeight: 812, adjusted: true,
    restored: false, restoreThreshold: 873, closing: false, closingTarget: null,
    inputValue: "unrelated-private-field",
  };
  for (let index = 0; index < 600; index += 1) recorder.mark("vv-resize", snapshot, controller);
  const data = recorder.snapshot();
  expect(data.marks).toHaveLength(512);
  expect(data.frames).toHaveLength(0);
  const raw = formatViewportDebugReport({ ...data, timeline: [], environment: {} });
  expect(raw).not.toContain("unrelated-private-field");
  expect(JSON.parse(raw).marks[0].snapshot).toMatchObject({ documentLockHeight: 812, documentLockBypassed: true });
});
