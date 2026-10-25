import { expect, test } from "vitest";
import { KeyboardDiagnosticsGate, KeyboardDiagnosticsReports, KEYBOARD_DIAGNOSTICS_MODES, type DiagnosticsGateInput } from "./keyboard-diagnostics";
import { ViewportFrameRecorder, VIEWPORT_FRAME_FIELDS, type ViewportFrameMeasure } from "./viewport-debug";
const closed: DiagnosticsGateInput = { width: 402, height: 874, viewportHeight: 874, viewportTop: 0, scale: 1, orientation: 0, focused: false, compensated: false, closing: false };
test("native blur and arbitrarily stable partial recovery never release the original closed baseline", () => {
  const gate = new KeyboardDiagnosticsGate(closed);
  expect(gate.check({ ...closed, focused: true })).toBe("focus");
  for (let index = 0; index < 100; index += 1) expect(gate.check({ ...closed, viewportHeight: 812 })).toBe("viewport");
  expect(gate.check({ ...closed, closing: true })).toBe("controller");
  expect(gate.check({ ...closed, compensated: true })).toBe("controller");
  expect(gate.check(closed)).toBe("ready");
});
test("missing/invalid viewport fails closed and rotation permanently requires restart", () => {
  expect(new KeyboardDiagnosticsGate(null).check(closed)).toBe("viewport");
  const gate = new KeyboardDiagnosticsGate(closed);
  expect(gate.check({ ...closed, scale: 1.1 })).toBe("viewport");
  expect(gate.check({ ...closed, viewportHeight: 0 })).toBe("viewport");
  expect(gate.check({ ...closed, width: 874, height: 402 })).toBe("restart");
  expect(gate.check(closed)).toBe("restart");
});
test("innerHeight compression is temporary and both viewport heights must fully recover", () => {
  const gate = new KeyboardDiagnosticsGate(closed);
  expect(gate.check({ ...closed, height: 470, viewportHeight: 470, focused: true })).toBe("focus");
  expect(gate.check({ ...closed, height: 470, viewportHeight: 470 })).toBe("viewport");
  expect(gate.check({ ...closed, height: 812, viewportHeight: 812 })).toBe("viewport");
  expect(gate.check({ ...closed, height: 812 })).toBe("viewport");
  expect(gate.check({ ...closed, viewportHeight: 812 })).toBe("viewport");
  expect(gate.check(closed)).toBe("ready");
});

test("report replaces revisits and keeps existing per-round frame/mark caps and columns", () => {
  const reports = new KeyboardDiagnosticsReports();
  const measure: ViewportFrameMeasure = { vvTop: 0, vvHeight: 874, vvPageTop: 0, vvScale: 1,
    scrollY: 0, innerHeight: 874, docHeight: 874, keyboard: false, motion: "none", cssTop: null, cssHeight: null,
    shellTop: 0, shellHeight: 874, titleTop: 0, composerTop: 700, listTop: 48,
    listScrollTop: 100, listScrollHeight: 1000, listClientHeight: 600, focus: "none" };
  let finish = () => {};
  for (let visit = 0; visit < 12; visit += 1) {
    finish();
    const mode = KEYBOARD_DIAGNOSTICS_MODES[visit % 3]!;
    const recorder = new ViewportFrameRecorder(() => visit);
    for (let index = 0; index < 1900; index += 1) { recorder.record(measure); recorder.mark("focusout"); }
    finish = reports.start(mode, () => ({ ...recorder.snapshot(), timeline: [], environment: { mode, visit } }));
  }
  const data = JSON.parse(reports.report());
  expect(data.rounds).toHaveLength(3);
  expect(data.rounds.map((round: { report: { environment: { visit: number } } }) => round.report.environment.visit)).toEqual([9, 10, 11]);
  for (const round of data.rounds) {
    expect(round.report.frames.columns).toEqual([...VIEWPORT_FRAME_FIELDS]);
    expect(round.report.frames.rows).toHaveLength(1800);
    expect(round.report.marks).toHaveLength(512);
    expect(round.report.frames.rows[0][0]).toBe(101);
  }
  finish();
  expect(JSON.parse(reports.report())).toEqual(data);
});
