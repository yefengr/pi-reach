import { expect, test, vi } from "vitest";
import { CAPTURE_CAPACITY, CAPTURE_DURATION_MS, CAPTURE_WAIT_MS, ViewportDiagnosticCapture, type CaptureMetadata } from "./timeline-viewport-diagnostic-capture";
import { ViewportDiagnostics, type ViewportDiagnosticGeometry } from "./timeline-viewport-diagnostics";
import type { ViewportTrace } from "./timeline-viewport-coordinator";

const entry: ViewportTrace = { following: true, unread: 0, paused: false, mode: "send", generation: 1,
  reason: "send", top: 20, bottom: 200, requested: null, actual: 20, effectiveTarget: 190, callbackTime: 80, motionTime: 75 };
const metadata: CaptureMetadata = { appVersion: "0.0.31", entryResource: "index-abc_123.js", standalone: true,
  displayMode: "standalone", dpr: 3, reducedMotion: false };
function fixture() {
  let id = 0;
  let now = 0;
  const timers = new Map<number, { run: () => void; ms: number }>();
  const collector = new ViewportDiagnostics(() => now);
  const capture = new ViewportDiagnosticCapture(collector, {
    set(run, ms) { timers.set(++id, { run, ms }); return id; }, clear(key) { timers.delete(key); },
  });
  const sample = vi.fn(() => ({ inputTop: 123 }) as ViewportDiagnosticGeometry);
  const fire = () => { const timer = [...timers.values()][0]!; timers.clear(); now += timer.ms; timer.run(); };
  return { collector, capture, timers, sample, fire };
}

test.each([null, undefined, 31, false])("non-string metadata is normalized without coercion (%s)", (value) => {
  const f = fixture();
  f.capture.arm({ ...metadata, appVersion: value, entryResource: value } as unknown as CaptureMetadata);
  f.capture.record(entry); f.fire();
  expect(f.capture.getSnapshot().report!.metadata).toEqual({ ...metadata, appVersion: "unknown", entryResource: null });
});

test("default off and armed stay geometry-free; first send is captured, frozen before disable and retained locally", () => {
  const f = fixture();
  const changes = vi.fn();
  f.capture.subscribe(changes);
  f.capture.record(entry, f.sample);
  expect(f.sample).not.toHaveBeenCalled();
  f.capture.arm(metadata);
  expect([...f.timers.values()][0].ms).toBe(CAPTURE_WAIT_MS);
  f.capture.record({ ...entry, reason: "frame" }, f.sample);
  expect(f.sample).not.toHaveBeenCalled();
  expect(f.collector.read()).toEqual([]);
  f.capture.record(entry, f.sample);
  expect(f.sample).toHaveBeenCalledTimes(1);
  expect([...f.timers.values()][0].ms).toBe(CAPTURE_DURATION_MS);
  f.capture.record({ ...entry, reason: "frame" }, f.sample);
  expect(changes).toHaveBeenCalledTimes(2);
  f.fire();
  const report = f.capture.getSnapshot().report!;
  expect(report.stopReason).toBe("duration");
  expect(report.entries).toHaveLength(2);
  expect(report.entries[0]).toMatchObject({ reason: "send", inputTop: 123, time: 0, effectiveTarget: 190 });
  expect(Object.isFrozen(report)).toBe(true);
  expect(Object.isFrozen(report.metadata)).toBe(true);
  expect(Object.isFrozen(report.entries[0])).toBe(true);
  expect(f.collector.isEnabled()).toBe(false);
  expect(f.collector.read()).toEqual([]);
  f.capture.terminate();
  expect(f.capture.getSnapshot().report).toBe(report);
  f.capture.record(entry, f.sample);
  expect(f.sample).toHaveBeenCalledTimes(2);
  expect(f.timers.size).toBe(0);
  f.capture.clear();
  expect(f.capture.getSnapshot()).toEqual({ phase: "off", report: null });
});

test("capacity stops before the bounded collector can drop the first send", () => {
  const f = fixture(); f.capture.arm(metadata);
  for (let generation = 0; generation < 300; generation++) f.capture.record({ ...entry, generation }, f.sample);
  const report = f.capture.getSnapshot().report!;
  expect(report.stopReason).toBe("capacity");
  expect(report.entries).toHaveLength(CAPTURE_CAPACITY);
  expect(report.entries[0].generation).toBe(0);
  expect(report.entries.at(-1)?.generation).toBe(255);
  expect(f.sample).toHaveBeenCalledTimes(CAPTURE_CAPACITY);
  expect(f.timers.size).toBe(0);
});

test.each(["cancel", "clear", "terminate"] as const)("%s invalidates armed/active stale timers and permits re-arm", (action) => {
  for (const active of [false, true]) {
    const f = fixture(); f.capture.arm(metadata);
    if (active) f.capture.record(entry);
    const late = [...f.timers.values()][0].run;
    f.capture[action]();
    expect(f.collector.isEnabled()).toBe(false);
    expect(f.timers.size).toBe(0);
    f.capture.arm(metadata); late();
    expect(f.capture.getSnapshot().phase).toBe("armed");
    f.capture.record(entry); late();
    expect(f.capture.getSnapshot().phase).toBe("recording");
    f.fire();
    expect(f.capture.getSnapshot().phase).toBe("complete");
  }
});

test("armed timeout stops without a report or geometry; metadata is rebuilt from the finite whitelist", () => {
  const f = fixture();
  f.capture.arm({ ...metadata, appVersion: "private", entryResource: "https://private/index-secret.js?token=secret", dpr: Infinity, token: "secret" } as CaptureMetadata);
  f.fire();
  expect(f.capture.getSnapshot()).toEqual({ phase: "timeout", report: null });
  expect(f.collector.isEnabled()).toBe(false);
  f.capture.arm({ ...metadata, appVersion: "private", entryResource: "path/private.js", dpr: Infinity, token: "secret" } as CaptureMetadata);
  f.capture.record({ ...entry, effectiveTarget: Infinity, callbackTime: NaN, motionTime: Infinity }); f.fire();
  const report = f.capture.getSnapshot().report!;
  expect(report.metadata).toEqual({ ...metadata, appVersion: "unknown", entryResource: null, dpr: null });
  expect(report.entries[0]).toMatchObject({ effectiveTarget: null, callbackTime: null, motionTime: null });
  expect(JSON.stringify(report)).not.toMatch(/private|secret|token/);
});
