import { expect, test, vi } from "vitest";
import { installViewportDiagnostics, recordViewportDiagnostic, ViewportDiagnostics, type ViewportDiagnosticGeometry } from "./timeline-viewport-diagnostics";
import type { ViewportTrace } from "./timeline-viewport-coordinator";
const entry: ViewportTrace = { following: true, unread: 0, paused: false, mode: "follow", generation: 1,
  reason: "commit", top: 0, bottom: 100, requested: 100, actual: 100 };
const geometry: ViewportDiagnosticGeometry = {
  listClientHeight: 300, listClientWidth: 400, listScrollHeight: 700, listScrollWidth: 400, listTop: 10, listHeight: 300,
  inputTop: 320, inputHeight: 44, footerTop: 310, footerHeight: 70, visualViewportHeight: 800, visualViewportWidth: 400,
  visualViewportOffsetTop: 0, visualViewportOffsetLeft: 0, visualViewportScale: 1,
};

test("diagnostics default off, bounded, isolated readonly, and cleared by disable", () => {
  let now = 50;
  const diagnostics = new ViewportDiagnostics(() => now);
  const sample = vi.fn(() => geometry);
  diagnostics.record(entry, sample);
  expect(sample).not.toHaveBeenCalled();
  expect(diagnostics.read()).toEqual([]);
  diagnostics.enable();
  now = 70;
  for (let index = 0; index < 300; index += 1) diagnostics.record({ ...entry, generation: index }, sample);
  const result = diagnostics.read();
  expect(result).toHaveLength(256);
  expect(result[0].generation).toBe(44);
  expect(result[0].time).toBe(20);
  expect(result[0]).toMatchObject(geometry);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result[0])).toBe(true);
  expect(result).not.toBe(diagnostics.read());
  expect(result[0]).not.toBe(diagnostics.read()[0]);
  diagnostics.disable();
  sample.mockClear();
  diagnostics.record(entry, sample);
  expect(sample).not.toHaveBeenCalled();
  expect(diagnostics.read()).toEqual([]);
  expect(result).toHaveLength(256);
});

test("only fixed enums and finite numeric geometry enter diagnostic storage", () => {
  const diagnostics = new ViewportDiagnostics(() => 0);
  diagnostics.enable();
  const candidate = { ...entry, message: "private", url: "private", token: "private" };
  const measured = { ...geometry, listClientHeight: Infinity, inputHeight: "private", footerTop: NaN, token: "private" };
  diagnostics.record(candidate, () => measured as unknown as ViewportDiagnosticGeometry);
  const result = diagnostics.read()[0];
  expect(Object.keys(result).sort()).toEqual([...Object.keys(entry), ...Object.keys(geometry), "time"].sort());
  expect(result.listClientHeight).toBeNull();
  expect(result.inputHeight).toBeNull();
  expect(result.footerTop).toBeNull();
  expect(JSON.stringify(result)).not.toContain("private");
  diagnostics.record({ ...entry, reason: "private" } as unknown as ViewportTrace);
  diagnostics.record({ ...entry, mode: "private" } as unknown as ViewportTrace);
  diagnostics.record({ ...entry, top: "private" } as unknown as ViewportTrace);
  diagnostics.record({ ...entry, actual: NaN });
  expect(diagnostics.read()).toHaveLength(1);
  diagnostics.clear();
  diagnostics.record(entry);
  for (const key of Object.keys(geometry) as (keyof ViewportDiagnosticGeometry)[]) expect(diagnostics.read()[0][key]).toBeNull();
});

test("production control keeps its fixed API and unbinding clears and disables sampling", () => {
  vi.stubGlobal("window", {});
  try {
    const cleanup = installViewportDiagnostics();
    const control = window.__PI_REACH_VIEWPORT__!;
    expect(Object.keys(control).sort()).toEqual(["clear", "disable", "enable", "read"]);
    control.enable();
    const sample = vi.fn(() => geometry);
    recordViewportDiagnostic(entry, sample);
    expect(control.read()).toHaveLength(1);
    cleanup();
    sample.mockClear();
    recordViewportDiagnostic(entry, sample);
    expect(control.read()).toEqual([]);
    expect(sample).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
