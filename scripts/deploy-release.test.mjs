import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const helper = new URL('./deploy-release.sh', import.meta.url).pathname;
const digest = `sha256:${'a'.repeat(64)}`;

function run(t, mode) {
  const root = mkdtempSync(join(tmpdir(), 'pi-reach-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync('/bin/bash', ['-eu', '-c', `
    git() { case "$1" in describe) echo previous-v1.0.0 ;; log) echo '- fix: 候选修复' ;; *) return 1 ;; esac; }
    gh() {
      printf '%s\\n' "$*" >> "$RUNNER_TEMP/calls"
      case "$2" in
        */git/ref/tags/*)
          if [ "$MODE" = new ]; then echo 'HTTP 404' >&2; return 1; fi
          if [ "$MODE" = api-failed ]; then echo 'HTTP 403' >&2; return 1; fi
          echo 'tag annotated-tag' ;;
        */git/tags/annotated-tag)
          if [ "$MODE" = wrong-source ]; then echo wrong-source; else echo "$GITHUB_SHA"; fi ;;
        */releases/tags/*)
          if [ "$MODE" = existing ]; then echo "digest $DIGEST";
          elif [ "$MODE" = wrong-digest ]; then echo different-digest;
          else echo 'HTTP 404' >&2; return 1; fi ;;
        *) echo created-tag ;;
      esac
    }
    . "$HELPER"
    release pwa PWA 1.0.1 ghcr.io/example/pi-reach-pwa:v1.0.1 "$DIGEST" https://pwa.example/app pwa packages/protocol
  `], { encoding: 'utf8', env: { ...process.env, MODE: mode, HELPER: helper, DIGEST: digest,
    RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: join(root, 'summary'), GITHUB_REPOSITORY: 'example/pi-reach', GITHUB_SHA: 'b'.repeat(40),
    GITHUB_SERVER_URL: 'https://github.com', RUN_URL: 'https://github.com/example/pi-reach/actions/runs/1' } });
  return { ...result, calls: readFileSync(join(root, 'calls'), 'utf8'), notes: readFileSync(join(root, 'pwa-v1.0.1.md'), 'utf8') };
}

test('new Release creates one annotated tag/ref and Release using the live digest', (t) => {
  const result = run(t, 'new');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /api repos\/example\/pi-reach\/git\/tags -f tag=pwa-v1.0.1/);
  assert.match(result.calls, /api repos\/example\/pi-reach\/git\/refs -f ref=refs\/tags\/pwa-v1.0.1/);
  assert.match(result.calls, /release create pwa-v1.0.1 --verify-tag/);
  assert.match(result.notes, /候选修复/);
});

test('tag-created/Release-failed rerun repairs only the missing Release', (t) => {
  const result = run(t, 'repair');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.calls, /-f tag=|-f ref=/);
  assert.match(result.calls, /release create/);
  assert.match(result.notes, /候选修复/);
});

test('already matching Release causes no duplicate tag or Release writes', (t) => {
  const result = run(t, 'existing');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.calls, /release create|-f tag=|-f ref=/);
});

for (const mode of ['wrong-source', 'wrong-digest', 'api-failed']) {
  test(`Release repair rejects ${mode} instead of overwriting public evidence`, (t) => {
    const result = run(t, mode);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.calls, /release create|-f tag=|-f ref=/);
  });
}
