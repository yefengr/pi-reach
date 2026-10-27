export const SCENARIOS = [
  { name: 'idle60', history: 60, mode: 'idle', frames: 0, intervalMs: 50, chunkChars: 64, durationMs: 5000 },
  { name: 'text0', history: 0, mode: 'text', frames: 120, intervalMs: 50, chunkChars: 64 },
  { name: 'text60', history: 60, mode: 'text', frames: 120, intervalMs: 50, chunkChars: 64 },
  { name: 'text300', history: 300, mode: 'text', frames: 120, intervalMs: 50, chunkChars: 64 },
  { name: 'long-blocks60', history: 60, mode: 'blocks', frames: 120, intervalMs: 50, chunkChars: 64 },
  { name: 'tool-reader60', history: 60, mode: 'tool', frames: 300, intervalMs: 20, chunkChars: 64 },
];
export const INITIAL_TEXT = '## Pi Reach measured response\n\n';
const LONG_UNIT = '## Stable Markdown\n\nPi Reach **response** with `inline code` and readable prose.\n\n| Field | Value |\n| --- | --- |\n| State | Stable |\n\n```typescript\nconst state = { ready: true, count: 42 };\nconsole.log(state);\n```\n\n';
export function initialText(config) {
  return config.mode === 'blocks' ? LONG_UNIT.repeat(Math.ceil(24576 / LONG_UNIT.length)) : config.mode === 'tool' ? 'Pi Reach tool output started.\n\n' : INITIAL_TEXT;
}
export function chunk(index, chars) {
  const source = `Reply ${index}: Pi Reach **response** with code and stable content. `;
  return source.repeat(Math.ceil(chars / source.length)).slice(0, chars) + `\n\n[AB:${String(index).padStart(4, '0')}]\n\n`;
}
export function makePartial(config, scope, index, cumulative) {
  const base = { protocol_version: 2, type: 'timeline_partial', session_id: scope.sessionId, leaf_id: scope.leafId, group_id: 'ab-live-run', status: 'delta' };
  if (config.mode === 'tool') return { ...base, partial_id: 'tool:ab-live-tool', kind: 'tool', tool_call_id: 'ab-live-tool', tool: 'bash', status: 'running', args: { command: 'printf benchmark-output', options: { label: 'Pi Reach isolated benchmark', padding: 'x'.repeat(1024) } }, blocks: [{ type: 'text', text: cumulative }] };
  if (config.mode === 'blocks') return { ...base, partial_id: 'ab-live:assistant:0', kind: 'assistant', blocks: [{ type: 'text', text: cumulative }] };
  return { ...base, partial_id: 'ab-live:assistant:0', kind: 'assistant', delta: index === 0 ? initialText(config) : chunk(index, config.chunkChars) };
}
export function finalFrames(config, scope, text) {
  const base = { session_id: scope.sessionId, leaf_id: scope.leafId, group_id: 'ab-live-run' };
  const body = text + '\n\n[ABFINAL]\n';
  const event = config.mode === 'tool'
    ? { ...base, event_id: 'ab-live-tool-result', event_seq: config.history + 1, timestamp: 1700001000000, kind: 'tool', tool_call_id: 'ab-live-tool', tool: 'bash', args: { command: 'printf benchmark-output', options: { label: 'Pi Reach isolated benchmark', padding: 'x'.repeat(1024) } }, status: 'complete', truncated: false, result: { content: [{ type: 'text', text: body }] } }
    : { ...base, event_id: 'ab-live', event_seq: config.history + 1, timestamp: 1700001000000, kind: 'assistant', status: 'complete', blocks: [{ type: 'text', text: body }] };
  const ended = { ...base, event_id: 'ab-run-end', event_seq: config.history + 2, timestamp: 1700001000001, kind: 'run_end', status: 'complete' };
  return [event, ended].map(value => ({ protocol_version: 2, type: 'timeline_event', session_id: scope.sessionId, leaf_id: scope.leafId, event: value }));
}
export function fnv(text, value = 2166136261) {
  let hash = value;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
  return hash;
}
export function expected(config, scope) {
  let text = initialText(config), hash = 2166136261, chars = 0;
  for (let index = 1; index <= config.frames; index += 1) {
    text += chunk(index, config.chunkChars);
    const json = JSON.stringify(makePartial(config, scope, index, text));
    hash = fnv(json, hash); chars += json.length;
  }
  return { text, hash, inputJsonChars: chars, finals: finalFrames(config, scope, text) };
}
