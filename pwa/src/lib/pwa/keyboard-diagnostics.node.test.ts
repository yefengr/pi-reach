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

test("pending calibration retains natural height and waits for either recovery order", () => {
  for (const partial of [{ ...closed, height: 812 }, { ...closed, viewportHeight: 812 }]) {
    const gate = new KeyboardDiagnosticsGate({ ...closed, height: 812, viewportHeight: 812 }, 874);
    expect(gate.baseline).toBeNull();
    expect(gate.check(partial)).toBe("viewport");
    expect(gate.baseline).toBeNull();
    expect(gate.check(closed)).toBe("ready");
    const baseline = gate.baseline;
    expect(baseline?.height).toBe(874);
    expect(gate.check({ ...closed, height: 470, viewportHeight: 470, focused: true }, 470)).toBe("focus");
    for (let index = 0; index < 100; index += 1) {
      expect(gate.check({ ...closed, height: 812, viewportHeight: 812 }, 812)).toBe("viewport");
    }
    expect(gate.baseline).toBe(baseline);
    expect(gate.check(closed)).toBe("ready");
  }
});
test.each([
  { focused: true }, { compensated: true }, { closing: true },
  { scale: 1.1 }, { scale: Number.NaN }, { height: 0 }, { viewportHeight: 0 },
  { width: 0 }, { width: Number.NaN }, { orientation: Number.NaN },
  { viewportHeight: null, viewportTop: null, scale: null },
])("initial unsafe input %j cannot establish a baseline until fully safe", unsafe => {
  const initial = { ...closed, ...unsafe };
  const gate = new KeyboardDiagnosticsGate(initial, 874);
  expect(gate.baseline).toBeNull();
  expect(gate.check(initial)).not.toBe("ready");
  expect(gate.baseline).toBeNull();
  expect(gate.check({ ...closed, height: 812 })).not.toBe("ready");
  expect(gate.baseline).toBeNull();
  expect(gate.check(closed)).toBe("ready");
});
test("pending shell compression cannot lower the initial natural height floor", () => {
  const gate = new KeyboardDiagnosticsGate({ ...closed, height: 470, viewportHeight: 470, focused: true }, 874);
  expect(gate.check({ ...closed, height: 470, viewportHeight: 470 }, 470)).toBe("viewport");
  expect(gate.baseline).toBeNull();
  expect(gate.check(closed, 874)).toBe("ready");
  const baseline = gate.baseline;
  expect(gate.check({ ...closed, height: 900, viewportHeight: 900 }, 900)).toBe("viewport");
  expect(gate.check({ ...closed, viewportTop: 12 })).toBe("viewport");
  expect(gate.check({ ...closed, closing: true })).toBe("controller");
  expect(gate.baseline).toBe(baseline);
  expect(gate.check(closed)).toBe("ready");
});
test.each([{ width: 874 }, { orientation: 90 }])("width/orientation change %j invalidates pending and established calibration", changed => {
  for (const pending of [false, true]) {
    const gate = new KeyboardDiagnosticsGate({ ...closed, viewportHeight: pending ? 812 : 874 }, 874);
    expect(gate.check({ ...closed, ...changed })).toBe("restart");
    expect(gate.check(closed)).toBe("restart");
  }
  expect(new KeyboardDiagnosticsGate(closed).check(closed)).toBe("ready");
  const taller = { ...closed, height: 900, viewportHeight: 900 };
  const fresh = new KeyboardDiagnosticsGate(taller);
  expect(fresh.check(taller)).toBe("ready");
  expect(fresh.check(closed)).toBe("viewport");
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
    const mode = KEYBOARD_DIAGNOSTICS_MODES[visit % KEYBOARD_DIAGNOSTICS_MODES.length]!;
    const recorder = new ViewportFrameRecorder(() => visit);
    for (let index = 0; index < 1900; index += 1) { recorder.record(measure); recorder.mark("focusout"); }
    finish = reports.start(mode, () => ({ ...recorder.snapshot(), timeline: [], environment: { mode, visit } }));
  }
  const data = JSON.parse(reports.report());
  expect(data.rounds).toHaveLength(4);
  expect(data.rounds.map((round: { mode: string }) => round.mode)).toEqual(["current", "prefixed", "native", "content"]);
  expect(data.rounds.map((round: { report: { environment: { visit: number } } }) => round.report.environment.visit)).toEqual([8, 9, 10, 11]);
  for (const round of data.rounds) {
    expect(round.report.frames.columns).toEqual([...VIEWPORT_FRAME_FIELDS]);
    expect(round.report.frames.rows).toHaveLength(1800);
    expect(round.report.marks).toHaveLength(512);
    expect(round.report.frames.rows[0][0]).toBe(101);
  }
  finish();
  expect(JSON.parse(reports.report())).toEqual(data);
});
