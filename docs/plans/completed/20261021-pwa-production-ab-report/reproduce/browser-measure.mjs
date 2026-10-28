import { fnv } from './workload.mjs';
const clock = () => performance.timeOrigin + performance.now();
let worker, configuration, scope, collected;

export async function prepare(config, targetScope) {
  configuration = config;
  scope = targetScope;
  worker = new Worker('/__bench/replay-worker.mjs', { type: 'module' });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Replay worker preparation timeout')), 10000);
    worker.onerror = () => { clearTimeout(timeout); reject(new Error('Replay worker failed')); };
    worker.onmessage = event => {
      if (event.data.type === 'ready') worker.postMessage({ type: 'configure', config, scope });
      if (event.data.type === 'configured') { clearTimeout(timeout); resolve(); }
    };
  });
}

function createProbe(config, state) {
  let animationFrame = 0, stopped = false;
  const selector = config.mode === 'tool' ? '.pwa-tool-reader-scroll' : '[data-timeline-key*="ab-live"]';
  const output = () => document.querySelector(selector)?.textContent ?? '';
  const contentRegion = document.querySelector(config.mode === 'tool' ? '.pwa-tool-reader-scroll' : '.pwa-message-list');
  const appRoot = document.querySelector('.pwa-root');
  state.probeRootContainsContent = Boolean(appRoot && contentRegion && appRoot.contains(contentRegion));
  if (!state.probeRootContainsContent) throw new Error('Output probe is outside the observed application root');
  const sample = stage => {
    if (stopped) return;
    const text = output();
    let at = text.lastIndexOf('[AB:');
    if (at >= 0 && text[at + 8] !== ']') at = text.lastIndexOf('[AB:', at - 1);
    const latest = at < 0 ? 0 : Number(text.slice(at + 4, at + 8));
    const now = clock();
    const previous = stage === 'dom' ? state.covered : state.rafCovered;
    if (stage === 'dom' && latest && latest < previous) state.regressions += 1;
    if (latest > previous) {
      const field = stage === 'dom' ? 'domAt' : 'rafAt';
      for (let index = previous + 1; index <= latest; index += 1) if (state.samples[index - 1]) state.samples[index - 1][field] = now;
      const advance = { atMs: now - state.startedAt, from: previous + 1, to: latest, frames: latest - previous, beforeFinal: !state.finalDeliveredAt };
      if (stage === 'dom') { state.covered = latest; state.domAdvances.push(advance); }
      else { state.rafCovered = latest; state.rafAdvances.push(advance); }
    }
    if (stage === 'dom' && text.includes('[ABFINAL]') && !state.finalDomAt) state.finalDomAt = now;
  };
  const mutation = new MutationObserver(records => {
    state.mutationBatches += 1;
    state.lastMutationAt = clock();
    if (!records.some(record => contentRegion.contains(record.target))) return;
    state.contentMutationBatches += 1;
    if (config.mode === 'idle') return;
    sample('dom');
    if (!animationFrame) animationFrame = requestAnimationFrame(() => { animationFrame = 0; sample('raf'); });
  });
  mutation.observe(appRoot, { subtree: true, childList: true, characterData: true });
  const takeLongTasks = entries => state.longTasks.push(...entries.map(entry => ({
    startMs: performance.timeOrigin + entry.startTime - state.startedAt, durationMs: entry.duration,
  })));
  const longTask = new PerformanceObserver(list => takeLongTasks(list.getEntries()));
  longTask.observe({ type: 'longtask', buffered: false });
  return { output, stop() {
    stopped = true;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    mutation.disconnect(); takeLongTasks(longTask.takeRecords()); longTask.disconnect();
  } };
}

async function waitForPersistenceAndQuiet(config, state) {
  const deadline = clock() + 15000;
  while (true) {
    if (!state.persistedAt) {
      const saved = await window.__ab.savedEvents();
      state.persistencePolls += 1;
      if (config.mode === 'idle' || saved.length === config.history + 2 && saved.some(value => value.event_id === 'ab-run-end')) state.persistedAt = clock();
    }
    if (state.persistedAt && clock() - state.lastMutationAt >= 250) return;
    if (clock() >= deadline) throw new Error('Persistence or layout did not settle');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export function run() {
  return new Promise((resolve, reject) => {
    const config = configuration, startedAt = clock();
    const state = {
      startedAt, finishedAt: 0, samples: [], longTasks: [], mutationBatches: 0, contentMutationBatches: 0,
      received: 0, hash: 2166136261, inputJsonChars: 0, covered: 0, rafCovered: 0, domAdvances: [], rafAdvances: [],
      finishScheduledAt: 0, finishReceivedAt: 0, activityBoundaryAt: 0, finalDeliveredAt: 0, finalDomAt: 0,
      coveredBeforeFinal: 0, regressions: 0, receiverErrors: [], persistencePolls: 0, persistedAt: 0, lastMutationAt: startedAt,
    };
    const probe = createProbe(config, state);
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Measured replay timed out')); }, 120000);
    function cleanup() { clearTimeout(timeout); probe.stop(); worker.terminate(); }
    worker.onmessage = async event => {
      const message = event.data;
      try {
        if (message.type === 'frame') {
          const receivedAt = clock(), json = JSON.stringify(message.frame);
          state.hash = fnv(json, state.hash); state.inputJsonChars += json.length; state.received += 1;
          state.samples.push({ index: message.index, scheduledAt: message.scheduledAt, dispatchedAt: message.dispatchedAt, receivedAt, domAt: null, rafAt: null });
          window.__ab.receive(message.frame);
          return;
        }
        if (message.type !== 'finish') return;
        state.finishScheduledAt = message.scheduledAt;
        state.finishReceivedAt = clock();
        await window.__abActivityBoundary();
        state.activityBoundaryAt = clock();
        state.coveredBeforeFinal = state.covered;
        state.finalDeliveredAt = clock();
        for (const incoming of message.frames) window.__ab.receive(incoming);
        if (config.mode !== 'idle') window.__ab.setWorking(false);
        await new Promise(done => setTimeout(done, 500));
        await waitForPersistenceAndQuiet(config, state);
        state.finishedAt = clock(); cleanup();
        collected = { ...state, outputText: probe.output(), snapshot: window.__ab.snapshot(),
          samples: state.samples.map(value => ({ index: value.index,
            scheduledMs: value.scheduledAt - startedAt, dispatchedMs: value.dispatchedAt - startedAt,
            receivedMs: value.receivedAt - startedAt, domMs: value.domAt === null ? null : value.domAt - startedAt,
            rafMs: value.rafAt === null ? null : value.rafAt - startedAt,
          })),
        };
        resolve();
      } catch (error) { state.receiverErrors.push(error.message); cleanup(); reject(error); }
    };
    worker.postMessage({ type: 'start' });
  });
}

export async function results() {
  if (!collected) throw new Error('Measurement is incomplete');
  const events = await window.__ab.savedEvents();
  const final = events.find(event => event.event_id === (configuration.mode === 'tool' ? 'ab-live-tool-result' : 'ab-live'));
  const ended = events.find(event => event.event_id === 'ab-run-end');
  const savedText = final?.kind === 'tool' ? final.result?.content?.[0]?.text : final?.blocks?.[0]?.text;
  const { outputText, ...values } = collected;
  const indices = [...outputText.matchAll(/\[AB:(\d{4})\]/g)].map(match => Number(match[1]));
  const domAllMarkers = configuration.mode === 'idle' || indices.length === configuration.frames && indices.every((value, index) => value === index + 1);
  return { ...values, outputHasFinal: outputText.includes('[ABFINAL]'), domAllMarkers, domMarkerCount: indices.length,
    outputLength: outputText.length, savedCount: events.length, savedText, ended: ended?.status === 'complete' };
}
