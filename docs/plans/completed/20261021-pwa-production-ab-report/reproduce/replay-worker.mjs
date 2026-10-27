import { initialText, chunk, makePartial, finalFrames } from './workload.mjs';
const now = () => performance.timeOrigin + performance.now();
let configuration;
postMessage({ type: 'ready' });
onmessage = event => {
  if (event.data.type === 'configure') { configuration = event.data; postMessage({ type: 'configured' }); return; }
  if (event.data.type !== 'start' || !configuration) return;
  const { config, scope } = configuration;
  const start = now() + 50;
  let index = 1, cumulative = initialText(config);
  function next() {
    const clock = now();
    while (index <= config.frames && clock >= start + (index - 1) * config.intervalMs) {
      const scheduledAt = start + (index - 1) * config.intervalMs;
      cumulative += chunk(index, config.chunkChars);
      postMessage({ type: 'frame', index, scheduledAt, dispatchedAt: now(), frame: makePartial(config, scope, index, cumulative) });
      index += 1;
    }
    if (index <= config.frames) { setTimeout(next, Math.max(0, start + (index - 1) * config.intervalMs - now())); return; }
    const end = config.mode === 'idle' ? start + config.durationMs : start + config.frames * config.intervalMs + 200;
    setTimeout(() => postMessage({ type: 'finish', scheduledAt: end, dispatchedAt: now(), frames: config.mode === 'idle' ? [] : finalFrames(config, scope, cumulative) }), Math.max(0, end - now()));
  }
  setTimeout(next, 50);
};
