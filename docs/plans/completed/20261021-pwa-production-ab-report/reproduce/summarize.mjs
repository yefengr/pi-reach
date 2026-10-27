import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './workload.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
export function quantile(values, p) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p, lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
export function distribution(values) {
  const numbers = values.filter(value => Number.isFinite(value));
  return { median: quantile(numbers, 0.5), min: numbers.length ? Math.min(...numbers) : null,
    max: numbers.length ? Math.max(...numbers) : null, values };
}
export function advanceGaps(advances) {
  return advances.slice(1).map((value, index) => value.atMs - advances[index].atMs);
}
function describe(trial) {
  const m = trial.measurements, samples = m.samples;
  const liveAdvances = m.domAdvances.filter(value => value.beforeFinal);
  const latency = callback => samples.map(callback).filter(Number.isFinite);
  const domSamples = samples.filter(value => value.domMs !== null);
  const live = trial.scenario.mode !== 'idle';
  return {
    taskMs: trial.metrics.TaskDuration * 1000,
    scriptMs: trial.metrics.ScriptDuration * 1000,
    activityTaskMs: trial.activityMetrics.TaskDuration * 1000,
    activityScriptMs: trial.activityMetrics.ScriptDuration * 1000,
    tailTaskMs: trial.tailMetrics.TaskDuration * 1000,
    tailScriptMs: trial.tailMetrics.ScriptDuration * 1000,
    layoutMs: trial.metrics.LayoutDuration * 1000,
    styleMs: trial.metrics.RecalcStyleDuration * 1000,
    wallMs: trial.metricWindowMs,
    activityWallMs: trial.activityWindowMs,
    tailWallMs: trial.tailWindowMs,
    mainThreadBusyPct: trial.metrics.TaskDuration * 100000 / trial.metricWindowMs,
    longTaskCount: m.longTasks.length,
    longTaskTotalMs: m.longTasks.reduce((sum, value) => sum + value.durationMs, 0),
    longestTaskMs: m.longTasks.length ? Math.max(...m.longTasks.map(value => value.durationMs)) : 0,
    heapEndMiB: trial.heap.end / 2 ** 20,
    heapRetainedMiB: trial.heap.retained / 2 ** 20,
    retainedGrowthMiB: (trial.heap.retained - trial.heap.baseline) / 2 ** 20,
    plannedDomP50Ms: quantile(domSamples.map(value => value.domMs - value.scheduledMs), 0.5),
    plannedDomP95Ms: quantile(domSamples.map(value => value.domMs - value.scheduledMs), 0.95),
    receivedDomP50Ms: quantile(domSamples.map(value => value.domMs - value.receivedMs), 0.5),
    receivedDomP95Ms: quantile(domSamples.map(value => value.domMs - value.receivedMs), 0.95),
    plannedRafP95Ms: quantile(samples.filter(value => value.rafMs !== null).map(value => value.rafMs - value.scheduledMs), 0.95),
    dispatchP95Ms: quantile(latency(value => value.dispatchedMs - value.scheduledMs), 0.95),
    receiveQueueP95Ms: quantile(latency(value => value.receivedMs - value.dispatchedMs), 0.95),
    finalDomMs: live ? m.finalDomAt - m.finalDeliveredAt : null,
    persistenceCompletionMs: live ? m.persistedAt - m.finalDeliveredAt : null,
    contentMutationBatches: m.contentMutationBatches,
    mutations: m.mutationBatches,
    coveredBeforeFormal: m.coveredBeforeFinal,
    observedLiveAdvances: trial.quality.observedLiveAdvances,
    liveAdvanceHz: live ? trial.quality.observedLiveAdvances * 1000 / trial.activityWindowMs : null,
    framesPerLiveAdvanceP95: quantile(liveAdvances.map(value => value.frames), 0.95),
    firstLiveAdvanceMs: liveAdvances[0]?.atMs ?? null,
    liveAdvanceGapP95Ms: quantile(advanceGaps(liveAdvances), 0.95),
    persistencePolls: m.persistencePolls,
  };
}
assert.deepEqual(advanceGaps([{ atMs: 1000 }, { atMs: 1020 }, { atMs: 1070 }]), [20, 50]);
assert.deepEqual(advanceGaps([{ atMs: 1000 }]), []);
assert.equal(quantile([1, 3], 0.5), 2);
assert.equal(quantile([], 0.5), null);
assert.ok(Math.abs(quantile(Array.from({ length: 20 }, (_, i) => i), 0.95) - 18.05) < 1e-10);
if (process.argv.includes('--self-test')) { console.log('statistics self-test passed'); process.exit(0); }
const raw = JSON.parse(fs.readFileSync(path.join(root, 'raw-results.json'), 'utf8'));
assert.equal(raw.kind, 'formal'); assert.equal(raw.complete, true); assert.equal(raw.errors.length, 0);
assert.equal(raw.trials.length, SCENARIOS.length * raw.repetitions * 2);
assert.ok(raw.trials.every(value => value.valid && Object.values(value.assertions).every(Boolean)));
for (const trial of raw.trials) {
  assert.ok(Math.abs(trial.metrics.TaskDuration - trial.activityMetrics.TaskDuration - trial.tailMetrics.TaskDuration) < 1e-8);
  assert.ok(Math.abs(trial.metricWindowMs - trial.activityWindowMs - trial.tailWindowMs) < 1e-4);
  assert.ok(trial.measurements.domAdvances.every(value => value.atMs >= 0 && value.atMs <= trial.durationMs));
  assert.ok(advanceGaps(trial.measurements.domAdvances).every(value => value >= 0));
}
const scenes = SCENARIOS.map(config => {
  const trials = raw.trials.filter(value => value.scenario.name === config.name);
  const values = {};
  for (const variant of ['before', 'after']) {
    const samples = trials.filter(value => value.variant === variant);
    assert.equal(samples.length, raw.repetitions);
    const descriptions = samples.map(describe);
    values[variant] = Object.fromEntries(Object.keys(descriptions[0]).map(key => [key, distribution(descriptions.map(value => value[key]))]));
  }
  const pairs = Array.from({ length: raw.repetitions }, (_, index) => {
    const before = trials.find(value => value.repetition === index + 1 && value.variant === 'before');
    const after = trials.find(value => value.repetition === index + 1 && value.variant === 'after');
    assert.equal(before.measurements.hash, after.measurements.hash);
    assert.equal(before.measurements.inputJsonChars, after.measurements.inputJsonChars);
    assert.equal(before.savedTextSha256, after.savedTextSha256);
    const a = describe(before), b = describe(after);
    return { repetition: index + 1, order: before.order === 1 ? 'AB' : 'BA',
      taskChangePct: (b.taskMs / a.taskMs - 1) * 100,
      scriptChangePct: (b.scriptMs / a.scriptMs - 1) * 100,
      plannedDomP95ChangeMs: a.plannedDomP95Ms === null ? null : b.plannedDomP95Ms - a.plannedDomP95Ms,
    };
  });
  return { config, samplesPerVersion: raw.repetitions, values, pairs,
    taskMedianChangePct: (values.after.taskMs.median / values.before.taskMs.median - 1) * 100,
    scriptMedianChangePct: (values.after.scriptMs.median / values.before.scriptMs.median - 1) * 100,
  };
});
const result = { environment: raw.environment, buildManifest: raw.buildManifest,
  startedAt: raw.startedAt, finishedAt: raw.finishedAt, complete: true,
  validSamples: raw.trials.length, totalSamples: raw.trials.length, scenes,
  interpretation: 'Per-version median across independent runs. Latency cells are medians of per-run percentiles, not pooled frames. Percent changes are ratios of version medians; paired changes retained separately. Desktop main-thread work is not phone energy or temperature.' };
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(result, null, 2));
for (const scene of scenes) console.log(JSON.stringify({ scenario: scene.config.name,
  taskBeforeMs: scene.values.before.taskMs.median, taskAfterMs: scene.values.after.taskMs.median,
  taskChangePct: scene.taskMedianChangePct,
  plannedP95BeforeMs: scene.values.before.plannedDomP95Ms.median, plannedP95AfterMs: scene.values.after.plannedDomP95Ms.median,
}));
