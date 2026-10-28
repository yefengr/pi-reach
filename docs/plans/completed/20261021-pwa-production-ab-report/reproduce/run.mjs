import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, initialText, makePartial, expected } from './workload.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = process.cwd();
const require = createRequire(path.join(repo, 'pwa/package.json'));
const { chromium } = require('playwright');
const pilot = process.argv.includes('--pilot');
const listArg = process.argv.find(arg => arg.startsWith('--scenarios='));
const names = listArg?.split('=')[1].split(',');
const scenarios = SCENARIOS.filter(value => !names || names.includes(value.name));
const repetitions = pilot ? 1 : 4;
if (!pilot && names) throw new Error('Formal runs must include the complete scenario matrix');
const startedAt = new Date().toISOString();
fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
const output = path.join(root, 'runs', `${pilot ? 'pilot' : 'formal'}-${startedAt.replace(/[:.]/g, '-')}.json`);
const latestOutput = path.join(root, pilot ? 'pilot-results.json' : 'raw-results.json');
if (fs.existsSync(output)) throw new Error('Run identifier collision');
const buildManifest = JSON.parse(fs.readFileSync(path.join(root, 'build-manifest.json'), 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function serve(name) {
  const dist = path.join(root, 'versions', name, 'pwa/dist');
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let file;
    if (url.pathname.startsWith('/__bench/')) file = path.join(root, path.basename(url.pathname));
    else if (url.pathname === '/' || url.pathname === '/app' || url.pathname.startsWith('/app/')) file = path.join(dist, 'index.html');
    else file = path.join(dist, decodeURIComponent(url.pathname));
    if ((!file.startsWith(dist + path.sep) && !['workload.mjs', 'replay-worker.mjs', 'browser-measure.mjs'].some(value => file === path.join(root, value))) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404); response.end('Not found'); return;
    }
    response.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
function metricsMap(response) { return Object.fromEntries(response.metrics.map(value => [value.name, value.value])); }
function delta(before, after, name) { return (after[name] ?? 0) - (before[name] ?? 0); }
const perfFields = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'];
function describe(config) { return { ...config, initialTextChars: config.mode === 'idle' ? 0 : initialText(config).length }; }

async function trial(browser, origin, variant, sourceConfig, repetition, order) {
  const config = pilot ? { ...sourceConfig, frames: sourceConfig.mode === 'idle' ? 0 : 12, durationMs: 1200 } : sourceConfig;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
    locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'no-preference', serviceWorkers: 'block' });
  const errors = [], external = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url.startsWith('blob:')) return route.continue();
    external.push(url); return route.abort();
  });
  await context.routeWebSocket('**/*', socket => { external.push(socket.url()); socket.close(); });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  let activityMetrics = null;
  await page.exposeBinding('__abActivityBoundary', async () => {
    if (activityMetrics) throw new Error('Duplicate activity boundary');
    activityMetrics = metricsMap(await cdp.send('Performance.getMetrics'));
  });
  try {
    await page.goto(`${origin}/app?history=${config.history}`, { waitUntil: 'load', timeout: 30000 });
    try { await page.waitForFunction(() => window.__ab?.ready, null, { timeout: 50000 }); }
    catch (error) { throw new Error('Fixture not ready: ' + JSON.stringify(await page.evaluate(() => window.__ab?.snapshot?.() ?? { missing: true })) + '; ' + error.message); }
    const scope = await page.evaluate(() => window.__ab.snapshot());
    if (scope.renderedHistory !== config.history || scope.errors.length) throw new Error('Invalid history preparation');
    if (config.mode !== 'idle') {
      const initial = makePartial(config, scope, 0, initialText(config));
      await page.evaluate(frame => { window.__ab.setWorking(true); window.__ab.receive(frame); }, initial);
      if (config.mode === 'tool') {
        await page.locator('.pwa-tool-group > .pwa-tool-head > button').click();
        await page.locator('.pwa-tool-card .pwa-tool-action').click();
        await page.locator('.pwa-tool-reader-scroll').waitFor({ state: 'visible' });
      } else await page.locator('[data-timeline-key*="ab-live"]').waitFor({ state: 'visible' });
    }
    await sleep(650);
    await page.evaluate(async config => {
      window.__measurement = await import('/__bench/browser-measure.mjs');
      await window.__measurement.prepare(config, window.__ab.snapshot());
    }, config);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    const prepared = await page.evaluate(() => ({ ...window.__ab.snapshot(), visibility: document.visibilityState }));
    const before = metricsMap(await cdp.send('Performance.getMetrics'));
    const nodeStart = performance.now();
    await page.evaluate(() => window.__measurement.run());
    const nodeElapsedMs = performance.now() - nodeStart;
    const after = metricsMap(await cdp.send('Performance.getMetrics'));
    if (!activityMetrics) throw new Error('Activity metrics were not captured');
    const data = await page.evaluate(() => window.__measurement.results());
    await cdp.send('HeapProfiler.collectGarbage');
    const retained = metricsMap(await cdp.send('Performance.getMetrics'));
    const input = expected(config, scope);
    const expectedFinal = input.text + '\n\n[ABFINAL]\n';
    const assertions = {
      realHistory: prepared.renderedHistory === config.history && data.snapshot.renderedHistory === config.history,
      receivedAll: data.received === config.frames,
      identicalInput: config.mode === 'idle' || data.hash === input.hash && data.inputJsonChars === input.inputJsonChars,
      noErrors: errors.length === 0 && external.length === 0 && data.receiverErrors.length === 0 && data.snapshot.errors.length === 0,
      savedComplete: config.mode === 'idle' ? data.savedCount === config.history : data.savedText === expectedFinal && data.savedCount === config.history + 2 && data.ended,
      finalShown: config.mode === 'idle' || data.outputHasFinal && data.domAllMarkers && data.covered === config.frames && data.finalDomAt > 0,
      countedFrames: data.snapshot.receivedFrames - prepared.receivedFrames === config.frames + (config.mode === 'idle' ? 0 : 2),
      foreground: prepared.visibility === 'visible',
      liveDisplayObserved: config.mode === 'idle' || data.probeRootContainsContent && data.contentMutationBatches > 0 && data.domAdvances.some(value => value.beforeFinal),
      nonRegressing: data.regressions === 0,
    };
    const valid = Object.values(assertions).every(Boolean);
    const savedTextHash = typeof data.savedText === 'string' ? hash(data.savedText) : null;
    delete data.savedText;
    return { variant, repetition, order, scenario: describe(config), valid, assertions, errors, external,
      durationMs: data.finishedAt - data.startedAt, nodeElapsedMs,
      metricWindowMs: delta(before, after, 'Timestamp') * 1000,
      activityWindowMs: delta(before, activityMetrics, 'Timestamp') * 1000,
      tailWindowMs: delta(activityMetrics, after, 'Timestamp') * 1000,
      metrics: Object.fromEntries(perfFields.map(name => [name, delta(before, after, name)])),
      activityMetrics: Object.fromEntries(perfFields.map(name => [name, delta(before, activityMetrics, name)])),
      tailMetrics: Object.fromEntries(perfFields.map(name => [name, delta(activityMetrics, after, name)])),
      quality: { framesCoveredBeforeFormal: data.coveredBeforeFinal, allCoveredBeforeFormal: data.coveredBeforeFinal === config.frames,
        observedLiveAdvances: data.domAdvances.filter(value => value.beforeFinal).length },
      heap: { baseline: before.JSHeapUsedSize, end: after.JSHeapUsedSize, retained: retained.JSHeapUsedSize },
      prepared, measurements: data, savedTextSha256: savedTextHash,
    };
  } finally { await context.close(); }
}

const servers = {};
let browser;
const result = {
  kind: pilot ? 'pilot-not-for-conclusions' : 'formal', startedAt, complete: false,
  units: { metricsDurations: 'seconds', metricCounts: 'counts', windowDurations: 'milliseconds',
    measurementAtTimes: 'epoch milliseconds', sampleAndLongTaskTimes: 'milliseconds relative to measurement start', heap: 'bytes' },
  environment: { node: process.version, platform: process.platform, arch: process.arch, osRelease: os.release(),
    cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryGiB: os.totalmem() / 2 ** 30,
    playwright: require('playwright/package.json').version, headless: true, cpuThrottlingRate: 1,
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC' },
  buildManifest, sourceHashes: Object.fromEntries(['build.mjs', 'workload.mjs', 'replay-worker.mjs', 'browser-measure.mjs', 'run.mjs'].map(file => [file, hash(fs.readFileSync(path.join(root, file)))])),
  repetitions, trials: [], errors: [],
};
function save() {
  const json = JSON.stringify(result, null, 2);
  fs.writeFileSync(output, json);
  fs.writeFileSync(latestOutput, json);
}
try {
  for (const variant of ['before', 'after']) servers[variant] = await serve(variant);
  browser = await chromium.launch({ headless: true });
  result.environment.chromium = browser.version();
  save();
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const variants = repetition % 2 === 0 ? ['before', 'after'] : ['after', 'before'];
    for (const config of scenarios) {
      for (let order = 0; order < variants.length; order += 1) {
        const variant = variants[order];
        console.log(`START ${repetition + 1}/${repetitions} ${config.name} ${variant}`);
        try {
          const measured = await trial(browser, servers[variant].origin, variant, config, repetition + 1, order + 1);
          result.trials.push(measured); save();
          console.log(JSON.stringify({ scenario: config.name, variant, valid: measured.valid, taskMs: Math.round(measured.metrics.TaskDuration * 1000), scriptMs: Math.round(measured.metrics.ScriptDuration * 1000), covered: measured.measurements.covered, assertions: measured.assertions }));
          if (!measured.valid) throw new Error(`Invalid measured sample: ${JSON.stringify(measured.assertions)}`);
        } catch (error) { result.errors.push({ scenario: config.name, variant, repetition: repetition + 1, message: error.message }); save(); throw error; }
      }
    }
  }
  if (result.trials.length !== scenarios.length * repetitions * 2) throw new Error('Incomplete sample matrix');
  result.complete = true;
} catch (error) {
  if (!result.errors.some(value => value.message === error.message)) result.errors.push({ phase: 'suite', message: error.message });
  console.error(error.message); process.exitCode = 1;
}
finally {
  if (browser) await browser.close();
  for (const entry of Object.values(servers)) await new Promise(resolve => entry.server.close(resolve));
  result.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ complete: result.complete, samples: result.trials.length, errors: result.errors.length, output: path.relative(repo, output) }));
}
