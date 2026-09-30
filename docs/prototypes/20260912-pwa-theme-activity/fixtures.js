/* Pi Reach prototype fixtures — simulated content only.
   No real sessions, tools, files or network data are used. */
(function () {
  'use strict';

  const STATUS_TEXT = {
    running: 'Running',
    complete: 'Completed',
    error: 'Failed',
    interrupted: 'Interrupted',
    uncertain: 'Unconfirmed',
  };

  /* ------------------------------------------------------- simulated file bodies */
  const TOOL_CARD_TS = [
    "import { useState } from 'react';",
    '',
    'export function ToolCard({ step }: { step: ToolStep }) {',
    '  const [open, setOpen] = useState(false);',
    '',
    '  return (',
    '    <section className="tool-card" data-status={step.status}>',
    '      <button aria-expanded={open} onClick={() => setOpen(!open)}>',
    '        <strong>{step.title}</strong>',
    '      </button>',
    '      {open ? <pre className="tool-output">{step.output}</pre> : null}',
    '    </section>',
    '  );',
    '}',
  ].join('\n');

  const PKG_JSON = JSON.stringify({
    name: 'pi-reach-pwa',
    private: true,
    scripts: {
      dev: 'next dev',
      build: 'next build',
      lint: 'next lint',
      test: 'vitest run',
      typecheck: 'tsc --noEmit',
    },
    dependencies: { '@mantine/core': '^8.0.0', next: '^15.0.0', react: '^19.0.0' },
  }, null, 2);

  const THEME_DIFF = [
    '.tool-output {',
    '-  max-height: none;',
    '-  overflow: visible;',
    '+  max-height: 12rem;',
    '+  overflow: auto;',
    '}',
  ];

  const ACTIVITY_GROUP_TS = [
    "export type StepStatus = 'running' | 'complete' | 'error';",
    '',
    'export interface ActivityStep {',
    '  id: string;',
    '  status: StepStatus;',
    '}',
    '',
    'export function visibleSteps(steps: ActivityStep[]): ActivityStep[] {',
    "  const finished = steps.filter((step) => step.status !== 'running');",
    '  const recent = new Set(finished.slice(-3).map((step) => step.id));',
    "  return steps.filter((step) => step.status === 'running' || recent.has(step.id));",
    '}',
    '',
    'export function issueCount(steps: ActivityStep[]): number {',
    "  return steps.filter((step) => step.status === 'error').length;",
    '}',
  ].join('\n');

  const THEME_CSS = [
    ':root {',
    '  --surface: #FFFFFF;',
    '  --ink: #1C1C1E;',
    '  --accent: #3A5A8C;',
    '  --accent-tint: #F2F5F9;',
    '}',
    '',
    '.activity-body {',
    '  display: grid;',
    '  gap: 12px;',
    '}',
    '',
    '.tool-output {',
    '  max-height: 12rem;',
    '  overflow: auto;',
    '}',
  ].join('\n');

  const TOKEN_DIFF = [
    ':root {',
    '-  --surface: #F7FBFF;',
    '-  --accent: #4FC3F7;',
    '+  --surface: #FFFFFF;',
    '+  --accent: #3A5A8C;',
    '+  --accent-tint: #F2F5F9;',
    '}',
  ];

  const COUNTER_TS = [
    'export let counter = 0;',
    '',
    'export function increment() {',
    '  counter += 1;',
    '  return counter;',
    '}',
  ].join('\n');

  const COUNTER_DIFF = [
    'export function increment() {',
    '-  counter += 1;',
    '-  return counter;',
    '+  activeCount += 1;',
    '+  return activeCount;',
    '}',
  ];

  const COUNTER_COPY_TS = [
    "export const COUNTER_LABEL = 'activeCount';",
    '',
    'export function counterCopy(value: number): string {',
    '  return `Currently active: ${value}`;',
    '}',
  ].join('\n');

  const EMPTY_DIFF = [
    'export function EmptyState() {',
    '-  return <p>No sessions yet</p>;',
    '+  return <p>Nothing here yet — pair a device to begin.</p>;',
    '}',
  ];

  const TSCONFIG_JSON = JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: { '@/timeline/*': ['./src/timeline/*'] },
    },
    include: ['src'],
  }, null, 2);

  const TSCONFIG_DIFF = [
    '  "paths": {',
    '-    "@/timeline/*": ["./src/old-timeline/*"]',
    '+    "@/timeline/*": ["./src/timeline/*"]',
    '  },',
  ];

  const PRETTIER_JSON = JSON.stringify({ semi: true, singleQuote: true, printWidth: 100 }, null, 2);

  const MIGRATE_TS = [
    'export interface MigrationStep { id: string; applied: boolean; }',
    '',
    'export function pending(steps: MigrationStep[]): MigrationStep[] {',
    '  return steps.filter((step) => !step.applied);',
    '}',
  ].join('\n');

  const AUDIT_RAW = {
    tool: 'audit_workspace',
    scanned: 418,
    issues: [{ path: 'src/legacy/panel.tsx', rule: 'unused-export' }],
  };

  const TEST_LOG = [
    '> vitest run --reporter=verbose',
    '',
    ' RUN  v3.2.4 /workspace/pi-reach/pwa',
    '',
    ' ✓ src/timeline/group-activity.test.ts > activity groups',
    '   ✓ keeps assistant text in its original position',
    '   ✓ splits one group into two segments around an explanation',
    '   ✓ keeps parallel tool order when one result arrives late',
    '   ✓ does not move a late result above an earlier running step',
    '',
    ' ✓ src/timeline/step-details.test.ts > renders a short preview per tool',
    '   ✓ renders a file preview without the full contents',
    '   ✓ renders a search preview with the match count',
    '   ✓ renders an applied diff with add and remove markers',
    '   ✓ falls back to plain JSON for unknown tools',
    '   ✓ keeps the original raw data available',
    '   ✓ labels each step with a semantic title',
    '   ✓ shows the running icon while a command is still active',
    '',
    ' ✓ src/timeline/reader.test.ts > reader panel behaviour',
    '   ✓ returns focus to the step button after closing',
    '   ✓ keeps the transcript scroll position',
    '   ✓ reopens raw data for the same step',
    '   ✓ switches between preview and raw tabs',
    '',
    ' ✓ src/components/tool-card.test.ts > collapses long output',
    '   ✓ shows the status label for each state',
    '   ✓ hides the output until the row is expanded',
    '   ✓ keeps a user collapse choice after a status update',
    '   ✓ keeps an error row visible while other steps run',
    '',
    ' ✓ src/timeline/earlier-actions.test.ts > earlier actions entry',
    '   ✓ lists the hidden action count',
    '   ✓ reports the issue count for hidden actions',
    '   ✓ restores the original order when expanded',
    '   ✓ keeps every running step visible',
    '',
    ' ✓ src/timeline/thinking.test.ts > thinking block',
    '   ✓ starts collapsed while thinking is streaming',
    '   ✓ shows "Thought process" after the group ends',
    '   ✓ does not show an endless spinner for unknown states',
    '',
    ' ✓ src/theme.test.ts > resolves light and dark tokens',
    '   ✓ follows the system preference by default',
    '   ✓ keeps a manual override across reloads',
    '   ✓ ignores storage errors without throwing',
    '   ✓ keeps the light palette on pure white',
    '',
    ' ✓ src/components/composer.test.ts > local prototype echo',
    '   ✓ marks every local message as not sent',
    '   ✓ clears the draft after a local echo',
    '   ✓ does not call any network client',
    '',
    ' ✓ src/timeline/uncertain-state.test.ts > unknown completion state',
    '   ✓ keeps the known results visible',
    '   ✓ does not render a permanent spinner',
    '   ✓ confirms completion after a reconnect event',
    '',
    ' ✓ src/components/sessions-dialog.test.ts > local session switch',
    '   ✓ changes the session label without connecting',
    '   ✓ keeps the outer navigation visible',
    '   ✓ announces that the switch is a demo',
    '',
    ' ✓ src/timeline/endpoint-status.test.ts > connection label',
    '   ✓ shows Connected for a live session',
    '   ✓ shows Status unknown after a reconnect',
    '   ✓ never guesses a completed state',
    '   ✓ restores the label when the session returns',
    '',
    ' ✓ src/timeline/activity-summary.test.ts > summary and issue counts',
    '   ✓ counts issues across the whole group',
    '   ✓ keeps the issue icon when a group finishes with errors',
    '   ✓ collapses a finished group by default',
    '   ✓ keeps a manual expand choice after a status update',
    '',
    ' ✓ src/components/dialog-focus.test.ts > dialog behaviour',
    '   ✓ opens one dialog at a time',
    '   ✓ returns focus to the opener after closing',
    '   ✓ keeps the transcript scroll position',
    '   ✓ closes on Escape',
    '',
    ' Test Files  13 passed (13)',
    '      Tests  58 passed (58)',
    '   Start at  10:24:31',
    '   Duration  1.82s (transform 214ms, setup 168ms, collect 402ms)',
  ];

  /* --------------------------------------------------------------- spec builders */
  const withBytes = (raw) => {
    if (typeof TextEncoder === 'function') raw.bytes = new TextEncoder().encode(raw.content).byteLength;
    return raw;
  };

  const file = (tool, path, content) => ({
    d: { kind: 'code', header: path, lines: content.split('\n') },
    raw: withBytes({ tool, path, content }),
  });

  const bash = (command, output, exitCode) => ({
    d: { kind: 'terminal', header: '$ ' + command, text: output },
    raw: { tool: 'bash', command, exitCode, stdout: output, stderr: '' },
  });

  const search = (pattern, items) => ({
    d: { kind: 'search', header: 'pattern "' + pattern + '" · ' + items.length + ' matches', items },
    raw: { tool: 'search', pattern, matches: items },
  });

  const patch = (path, lines) => ({
    d: { kind: 'diff', header: path, lines },
    raw: { tool: 'edit', path, applied: true, patch: lines.join('\n') },
  });

  const writeFile = (path, content) => ({
    d: { kind: 'write', header: path, text: content },
    raw: withBytes({ tool: 'write', path, created: true, content }),
  });

  const unknownTool = (name, raw) => ({
    d: { kind: 'fallback', header: name, text: JSON.stringify(raw, null, 2) },
    raw,
  });

  const S = (id, tool, title, status, spec, extra) => Object.assign({
    id,
    tool,
    title,
    status,
    statusText: STATUS_TEXT[status],
    d: spec.d,
    raw: spec.raw,
  }, extra || {});

  const msg = (role, label, blocks, extra) => Object.assign({ type: 'message', role, label, blocks }, extra || {});
  const user = (text) => msg('user', 'You', [{ t: 'p', text }]);
  const assistant = (blocks) => msg('assistant', 'Pi Reach', blocks);
  const final = (title, blocks, foot) => msg('final', 'Pi Reach', blocks, { title, foot });
  const activity = (id, group, state, heading, subtitle, steps, extra) =>
    Object.assign({ type: 'activity', id, group, state, heading, subtitle, steps }, extra || {});
  const thinking = (id, paras, streaming) => ({ id, paras, streaming: streaming !== false });

  const BASE = {
    sessionLabel: 'pi-reach',
    endpoint: 'Development Mac / pi-reach',
    connection: 'online',
    connectionLabel: 'Connected',
    hint: 'Prototype only — messages stay on this page and are not sent.',
  };

  /* ------------------------------------------------------------------ scenarios */
  const running = Object.assign({}, BASE, {
    id: 'running',
    title: 'Mobile tool timeline',
    advance: {
      final: final('Timeline output updated', [
        { t: 'p', text: 'Long tool output now starts collapsed, and the activity group keeps every action in its original order.' },
        { t: 'ul', items: ['Read and Search previews stay short.', 'Edit and Write results open in the reader panel.', 'An earlier-actions entry keeps old steps reachable.'] },
      ], 'Simulated result for review only.'),
    },
    nodes: [
      user('Can you tidy up the mobile tool timeline so long output is collapsed by default?'),
      assistant([{ t: 'p', text: 'I will check how the current tool card renders output, then adjust the theme rules so long results start collapsed.' }]),
      activity('seg-run-1', 'grp-run-1', 'running', 'Timeline components', '6 of 7 actions finished · 1 running', [
        S('run-read-card', 'Read', 'src/components/tool-card.tsx', 'complete', file('read', 'src/components/tool-card.tsx', TOOL_CARD_TS)),
        S('run-search', 'Search', 'activity group', 'complete', search('activity group', [
          { path: 'src/timeline/render.ts', line: 18, text: 'const groups = groupActivity(items);' },
          { path: 'src/timeline/render.ts', line: 54, text: "group.state === 'running' ? openByDefault : collapsed" },
          { path: 'src/components/tool-card.tsx', line: 4, text: 'const [open, setOpen] = useState(false);' },
          { path: 'src/theme.css', line: 96, text: '.tool-output {' },
        ])),
        S('run-pkg', 'Read', 'package.json', 'complete', file('read', 'package.json', PKG_JSON)),
        S('run-test', 'Bash', 'pnpm test', 'complete', bash('pnpm test', TEST_LOG.join('\n'), 0)),
        S('run-edit', 'Edit', 'src/theme.css', 'complete', patch('src/theme.css', THEME_DIFF)),
        S('run-write', 'Write', 'src/timeline/activity-group.ts', 'complete', writeFile('src/timeline/activity-group.ts', ACTIVITY_GROUP_TS)),
        S('run-typecheck', 'Bash', 'pnpm typecheck', 'running', bash('pnpm typecheck', 'Checking project references…', null), {
          done: bash('pnpm typecheck', 'Checking 42 files…\nNo type errors found.', 0),
        }),
      ], {
        thinking: thinking('th-run-1', [
          'The request is about how long tool output is shown on small screens.',
          'I will read the current tool card, search for the collapse rule, then adjust the theme CSS and verify with the test and typecheck commands.',
        ]),
        doneSubtitle: '7 actions finished · long output collapses by default',
      }),
    ],
  });

  const conversation = Object.assign({}, BASE, {
    id: 'conversation',
    title: 'Final answer format',
    advance: null,
    nodes: [
      user('What does the final answer card show?'),
      activity('seg-conv-1', 'grp-conv-1', 'complete', 'Reasoning', 'No tool calls in this turn', [], {
        thinking: thinking('th-conv-1', [
          'The question is about presentation, not about running a tool.',
          'I will answer directly and keep the reply short.',
        ], false),
      }),
      assistant([{ t: 'p', text: 'The final answer card shows the outcome first, then a short explanation, then a note that the reply is simulated.' }]),
      final('Final answer card', [
        { t: 'p', text: 'The card stays independent from the activity group: collapsing tool output never hides the final answer.' },
        { t: 'ul', items: ['Outcome first.', 'Short evidence list.', 'Simulated-result note.'] },
      ], 'Simulated reply for review only.'),
    ],
  });

  const interleaved = Object.assign({}, BASE, {
    id: 'interleaved',
    title: 'Two segments, one group',
    advance: {
      final: final('Rename finished after verification', [
        { t: 'p', text: 'Both segments of the same group are complete now: the rename, the copy helper and the two verification commands all finished.' },
        { t: 'p', text: 'The explanation between the segments stayed where it was; nothing moved to the top or the bottom of the group.' },
      ], 'Simulated result for review only.'),
    },
    nodes: [
      user('Rename the counter to activeCount but keep your explanations where they are.'),
      activity('seg-int-1', 'grp-int-1', 'running', 'Rename counter', '2 of 3 actions finished · verification running', [
        S('int-a1', 'Read', 'src/timeline/counter.ts', 'complete', file('read', 'src/timeline/counter.ts', COUNTER_TS)),
        S('int-a2', 'Edit', 'src/timeline/counter.ts', 'complete', patch('src/timeline/counter.ts', COUNTER_DIFF)),
        S('int-a3', 'Bash', 'pnpm test src/timeline', 'running', bash('pnpm test src/timeline', ' Running 6 tests…', null), {
          done: bash('pnpm test src/timeline', ' Test Files  1 passed (1)\n      Tests  6 passed (6)', 0),
        }),
      ], {
        thinking: thinking('th-int-1', [
          'The rename touches the component and the test name.',
          'I will edit the source first and keep the running test visible.',
        ]),
        doneSubtitle: '3 actions finished',
      }),
      assistant([{ t: 'p', text: 'The rename is applied. The src/timeline test run is still going, so this turn is not finished yet.' }]),
      activity('seg-int-2', 'grp-int-1', 'running', 'Copy references', '2 of 3 actions finished · 1 running', [
        S('int-b1', 'Search', 'counter label', 'complete', search('counter label', [
          { path: 'src/components/summary.tsx', line: 22, text: '<span className={styles.count}>{counter}</span>' },
          { path: 'src/timeline/counter.ts', line: 9, text: 'export function counterLabel(value: number) {' },
        ])),
        S('int-b2', 'Write', 'src/timeline/counter-copy.ts', 'complete', writeFile('src/timeline/counter-copy.ts', COUNTER_COPY_TS)),
        S('int-b3', 'Bash', 'pnpm lint', 'running', bash('pnpm lint', 'Linting 128 files…', null), {
          done: bash('pnpm lint', 'Checked 128 files · no problems found.', 0),
        }),
      ], {
        thinking: thinking('th-int-2', [
          'The remaining references are documentation strings.',
          'I will update the copy helper and run lint.',
        ]),
        doneSubtitle: '3 actions finished',
      }),
    ],
  });

  const parallel = Object.assign({}, BASE, {
    id: 'parallel',
    title: 'Parallel checks',
    advance: {
      final: final('Parallel checks finished', [
        { t: 'p', text: 'All simulated commands reported success. The two earlier results stay reachable behind the earlier-actions entry.' },
        { t: 'ul', items: ['pnpm format:check passed.', 'pnpm lint passed.', 'pnpm build passed.'] },
      ], 'Simulated result — no build ran in this prototype.'),
    },
    nodes: [
      user('Run formatting, types and unit tests in parallel.'),
      activity('seg-par-1', 'grp-par-1', 'running', 'Parallel checks', '5 of 7 actions finished · 2 running', [
        S('par-fmt', 'Bash', 'pnpm format:check', 'complete', bash('pnpm format:check', 'All matched files use the expected format.', 0)),
        S('par-type', 'Bash', 'pnpm typecheck', 'running', bash('pnpm typecheck', 'Checking project references…', null), {
          done: bash('pnpm typecheck', 'Checking 42 files…\nNo type errors found.', 0),
        }),
        S('par-test', 'Bash', 'pnpm test', 'running', bash('pnpm test', ' Running 24 tests…', null), {
          done: bash('pnpm test', ' Test Files  3 passed (3)\n      Tests  24 passed (24)', 0),
        }),
        S('par-lint', 'Bash', 'pnpm lint', 'complete', bash('pnpm lint', 'Checked 128 files · no problems found.', 0)),
        S('par-build', 'Bash', 'pnpm build', 'complete', bash('pnpm build', ' ✓ Compiled successfully\n  Route (app)   Size\n  /app          148 kB', 0)),
        S('par-prettier', 'Read', '.prettierrc.json', 'complete', file('read', '.prettierrc.json', PRETTIER_JSON)),
        S('par-search', 'Search', 'snapshot', 'complete', search('snapshot', [
          { path: 'src/components/step-view.tsx', line: 31, text: 'expect(container).toMatchSnapshot();' },
          { path: 'vitest.config.ts', line: 7, text: 'snapshotFormat: { escapeString: true }' },
        ])),
      ], {
        thinking: thinking('th-par-1', [
          'Three commands can run at the same time.',
          'I will keep their original request order even while one of them finishes early.',
        ]),
        doneSubtitle: '7 actions finished',
      }),
    ],
  });

  const completed = Object.assign({}, BASE, {
    id: 'completed',
    title: 'Theme token summary',
    advance: null,
    nodes: [
      user('Summarize what changed in the theme tokens.'),
      activity('seg-done-1', 'grp-done-1', 'complete', 'Theme tokens', '4 actions finished', [
        S('done-read', 'Read', 'src/theme.css', 'complete', file('read', 'src/theme.css', THEME_CSS)),
        S('done-search', 'Search', 'indigo', 'complete', search('indigo', [
          { path: 'src/theme.css', line: 12, text: '--accent: #3A5A8C;' },
          { path: 'src/theme.css', line: 13, text: '--accent-tint: #F2F5F9;' },
        ])),
        S('done-edit', 'Edit', 'src/theme.css', 'complete', patch('src/theme.css', TOKEN_DIFF)),
        S('done-build', 'Bash', 'pnpm build', 'complete', bash('pnpm build', ' ✓ Compiled successfully', 0)),
      ], {
        thinking: thinking('th-done-1', [
          'I already know these files from earlier turns.',
          'I will summarize the token change instead of re-running everything.',
        ], false),
      }),
      final('Theme token summary', [
        { t: 'p', text: 'The light palette now uses an indigo accent on a pure white surface, replacing the previous sky blue.' },
        { t: 'ul', items: ['`--surface` is now `#FFFFFF`.', '`--accent` moved from `#4FC3F7` to `#3A5A8C`.', '`--accent-tint` adds `#F2F5F9` for selected rows.'] },
      ], 'Simulated summary — the group above is collapsed by default.'),
    ],
  });

  const errorScenario = Object.assign({}, BASE, {
    id: 'error',
    title: 'Empty state copy',
    advance: {
      final: final('Copy updated — one check still fails', [
        { t: 'p', text: 'The empty state copy is updated. **pnpm test** still fails in `empty-state.test.tsx`, and I did not fix or re-run it in this session.' },
        { t: 'p', text: 'The failed command and its output stay in the group above, and the group still reports 1 issue.' },
      ], 'Simulated result — not every check passed.'),
    },
    nodes: [
      user('Update the empty state copy and make sure the checks still pass.'),
      activity('seg-err-1', 'grp-err-1', 'error', 'Empty state copy', '2 of 3 actions finished · 1 issue', [
        S('err-edit', 'Edit', 'src/components/empty-state.tsx', 'complete', patch('src/components/empty-state.tsx', EMPTY_DIFF)),
        S('err-test', 'Bash', 'pnpm test', 'error', bash('pnpm test', ' FAIL  src/components/empty-state.test.tsx > renders the empty state\n Expected: "Nothing here yet"\n Received: "No sessions yet"\n\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 23 passed (24)', 1)),
        S('err-lint', 'Bash', 'pnpm lint', 'running', bash('pnpm lint', 'Linting 128 files…', null), {
          done: bash('pnpm lint', 'Checked 128 files · no problems found.', 0),
        }),
      ], {
        thinking: thinking('th-err-1', [
          'The copy change may break the snapshot expectation.',
          'I will update the component first, then run the test command and keep any failure visible.',
        ]),
        doneSubtitle: 'Finished with 1 unresolved issue',
      }),
    ],
  });

  const recovered = Object.assign({}, BASE, {
    id: 'recovered',
    title: 'Build recovery',
    advance: null,
    nodes: [
      user('The build failed earlier — find out why and retry.'),
      activity('seg-rec-1', 'grp-rec-1', 'complete', 'Build recovery', '5 actions · 1 issue resolved after retry', [
        S('rec-build-1', 'Bash', 'pnpm build', 'error', bash('pnpm build', ' ✗ Type error: Cannot find module "@/timeline/activity-group"\n   at src/timeline/render.ts:9:8', 1)),
        S('rec-read', 'Read', 'tsconfig.json', 'complete', file('read', 'tsconfig.json', TSCONFIG_JSON)),
        S('rec-edit', 'Edit', 'tsconfig.json', 'complete', patch('tsconfig.json', TSCONFIG_DIFF)),
        S('rec-build-2', 'Bash', 'pnpm build', 'complete', bash('pnpm build', ' ✓ Compiled successfully', 0)),
        S('rec-audit', 'audit_workspace', 'workspace scan', 'complete', unknownTool('audit_workspace', AUDIT_RAW)),
      ], {
        thinking: thinking('th-rec-1', [
          'The error mentions a path alias, so tsconfig.json is the likely cause.',
          'I will fix the alias, rebuild, and run the workspace audit tool even though it has no dedicated view.',
        ], false),
      }),
      final('Build now passes after the alias fix', [
        { t: 'p', text: 'The first build failed because `tsconfig.json` still pointed `@/timeline/*` at the old path. After the edit, the build succeeded.' },
        { t: 'p', text: 'The failed attempt stays in the group above; the group reports 1 issue even though it is collapsed by default.' },
      ], 'Simulated result — both attempts are static fixture data.'),
    ],
  });

  const uncertain = Object.assign({}, BASE, {
    id: 'uncertain',
    title: 'Migration status',
    connection: 'unknown',
    connectionLabel: 'Status unknown',
    advance: {
      connection: 'online',
      connectionLabel: 'Connected',
      final: final('Migration finished while disconnected', [
        { t: 'p', text: 'The reconnect delivered the final completion event, so the group is now confirmed complete.' },
        { t: 'p', text: 'Everything that was already known before the reconnect is kept in place.' },
      ], 'Simulated recovery — no real reconnect happened.'),
    },
    nodes: [
      user('Did the migration finish?'),
      activity('seg-unc-1', 'grp-unc-1', 'uncertain', 'Migration status', 'Status unknown after reconnect · known results kept', [
        S('unc-read', 'Read', 'src/timeline/migrate.ts', 'complete', file('read', 'src/timeline/migrate.ts', MIGRATE_TS)),
        S('unc-check', 'Bash', 'pnpm migrate --check', 'complete', bash('pnpm migrate --check', 'Dry run: 12 of 12 steps reported readable state.', 0)),
        S('unc-audit', 'audit_workspace', 'schema snapshot', 'complete', unknownTool('audit_workspace', {
          tool: 'audit_workspace',
          scanned: 418,
          last_run: '2026-09-12T08:41:00Z',
          status: 'unknown',
        })),
      ], {
        thinking: thinking('th-unc-1', [
          'The connection dropped before the completion event arrived.',
          'I will show the known results and mark the group as unconfirmed instead of guessing.',
        ], false),
        doneSubtitle: 'Completion confirmed after reconnect',
      }),
    ],
  });

  window.RP_FIXTURES = {
    defaultScenario: 'running',
    themeColor: { light: '#FFFFFF', dark: '#1C1C1E' },
    scenarios: {
      running,
      conversation,
      interleaved,
      parallel,
      completed,
      error: errorScenario,
      recovered,
      uncertain,
    },
  };
})();
