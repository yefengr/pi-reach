import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'packages/pwa-foundation/publish-npm.sh');
const TOKEN = 'secret-that-must-not-leak';
const OIDC = { GITHUB_ACTIONS:'true', GITHUB_SHA:'a'.repeat(40), GITHUB_REPOSITORY:'yefengr/pi-reach', GITHUB_REF:'refs/heads/main', ACTIONS_ID_TOKEN_REQUEST_URL:'https://example.invalid', ACTIONS_ID_TOKEN_REQUEST_TOKEN:TOKEN };
const SHA = 'a'.repeat(40);
const CLI = String.raw`#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import cp from 'node:child_process';
const name=path.basename(process.argv[1]), args=process.argv.slice(2), root=process.env.FAKE_ROOT;
fs.appendFileSync(path.join(root,'calls'),JSON.stringify([name,...args])+'\n');
if(name==='git') { console.log('a'.repeat(40)); process.exit(0); }
if(name==='curl') { console.log(process.env.HTTP_STATUS || '404'); process.exit(process.env.NETWORK_FAIL ? 1 : 0); }
if(name==='npm') {
  const user=process.env.NPM_CONFIG_USERCONFIG, global=process.env.NPM_CONFIG_GLOBALCONFIG;
  const config={user,global,userBytes:fs.statSync(user).size,globalBytes:fs.statSync(global).size,
    userMode:fs.statSync(user).mode & 0o777,globalMode:fs.statSync(global).mode & 0o777,
    dirMode:fs.statSync(path.dirname(user)).mode & 0o777,
    lowercaseUser:process.env.npm_config_userconfig,lowercaseGlobal:process.env.npm_config_globalconfig};
  fs.appendFileSync(path.join(root,'configs'),JSON.stringify(config)+'\n');
}
if(name==='npm' && args[0]==='--version') {
  if(process.env.REAL_NPM) {
    const result=cp.spawnSync(process.execPath,[process.env.REAL_NPM,'--version'],{encoding:'utf8'});
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    process.exit(result.status ?? 1);
  }
  console.log(process.env.NPM_VERSION || '11.19.1'); process.exit(0);
}
if(name==='npm' && args[0]==='stage' && args[1]==='publish') {
  const bytes=fs.readFileSync(args[2]);
  fs.writeFileSync(path.join(root,'uploaded'),bytes);
  process.exit(process.env.UPLOAD_FAIL ? 1 : 0);
}
if(name==='pnpm' && args[0]==='--filter') process.exit(process.env.BUILD_FAIL ? 1 : 0);
if(name==='pnpm' && args[0]==='pack') {
  if(process.env.PACK_FAIL) process.exit(1);
  const destination=args[args.indexOf('--pack-destination')+1];
  const pkg=JSON.parse(fs.readFileSync('package.json'));
  if(process.env.BAD_NAME) pkg.name='@other/package';
  if(process.env.BAD_VERSION) pkg.version='1.2.3';
  if(process.env.BAD_EXPORT) pkg.exports['.'].default='./dist/missing.js';
  fs.writeFileSync(path.join(root,'payload/package/package.json'),JSON.stringify(pkg));
  if(process.env.BAD_FILE) fs.writeFileSync(path.join(root,'payload/package/.env'),'private');
  if(process.env.BAD_DIST_TEST) fs.writeFileSync(path.join(root,'payload/package/dist/test.js'),'fixture');
  if(process.env.BAD_LINK) fs.symlinkSync('/etc/passwd',path.join(root,'payload/package/dist/evil.js'));
  const r=cp.spawnSync('tar',['-czf',path.join(destination,'package.tgz'),'-C',path.join(root,'payload'),'package']);
  if(process.env.TWO_TARS) fs.copyFileSync(path.join(destination,'package.tgz'),path.join(destination,'another.tgz'));
  process.exit(r.status);
}
process.exit(90);
`;
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'foundation-release-test-'));
  for(const dir of ['bin','tmp','payload/package/dist']) mkdirSync(join(root,dir),{recursive:true});
  copyFileSync(SCRIPT,join(root,'publish-npm.sh'));
  const pkg=JSON.parse(readFileSync(join(ROOT,'packages/pwa-foundation/package.json')));
  pkg.version='9.9.9';
  writeFileSync(join(root,'package.json'),JSON.stringify(pkg));
  for(const file of ['README.md','LICENSE','DESIGN.md','CHANGELOG.md','foundation.css','theme.css','controls.css','dist/index.js','dist/index.d.ts','dist/mantine.js','dist/mantine.d.ts']) writeFileSync(join(root,'payload/package',file),'fixture');
  writeFileSync(join(root,'calls'),'');
  for(const name of ['npm','pnpm','git','curl']) { writeFileSync(join(root,'bin',name),CLI); chmodSync(join(root,'bin',name),0o755); }
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return root;
}
function run(root,args=[],extra={}) {
  const env={...process.env};
  for(const key of [...Object.keys(OIDC),'NPM_TOKEN','NODE_AUTH_TOKEN','PWA_FOUNDATION_PACK_DIR','NPM_CONFIG_USERCONFIG','NPM_CONFIG_GLOBALCONFIG','npm_config_userconfig','npm_config_globalconfig','REAL_NPM','EXPECTED_SHA256','EXPECTED_VERSION','GITHUB_OUTPUT']) delete env[key];
  return spawnSync('/bin/bash',[join(root,'publish-npm.sh'),...args],{encoding:'utf8',env:{...env,PATH:`${join(root,'bin')}:${process.env.PATH}`,TMPDIR:join(root,'tmp'),FAKE_ROOT:root,...extra}});
}
function prepare(root, extra={}) {
  const out=join(root,'artifact');
  success(run(root,[],{PWA_FOUNDATION_PACK_DIR:out,...extra}));
  const meta=JSON.parse(readFileSync(join(out,'metadata.json')));
  writeFileSync(join(root,'calls'),'');
  return {out,env:{...OIDC,EXPECTED_SHA256:meta.sha256,EXPECTED_VERSION:meta.version}};
}
function stage(root, extra={}) {
  const {out,env}=prepare(root);
  return run(root,['--stage',out],{...env,...extra});
}
function calls(root) { return readFileSync(join(root,'calls'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
function success(r) { assert.equal(r.status,0,r.stdout+r.stderr); assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN)); }
function noUpload(root) { assert.ok(!calls(root).some(c=>c[0]==='npm' && c[1]!=='--version')); }
test('default validates and packs once, never contacts registry/upload; temporary directory is cleaned',t=>{
  const root=fixture(t); success(run(root));
  assert.deepEqual(calls(root).map(c=>c.slice(0,2)),[['git','rev-parse'],['pnpm','--filter'],['pnpm','pack']]);
  assert.deepEqual(readdirSync(join(root,'tmp')),[]);
});
test('OIDC uploads exactly the inspected tarball once and retains verifiable safe metadata',t=>{
  const root=fixture(t), {out,env}=prepare(root);
  const before=readdirSync(out).map(file=>[file,readFileSync(join(out,file))]);
  success(run(root,['--stage',out],env));
  for(const [file,bytes] of before) assert.deepEqual(readFileSync(join(out,file)),bytes);
  const log=calls(root);
  assert.deepEqual(log.map(c=>c[0]),['git','npm','curl','npm']);
  assert.deepEqual(log.at(-1),['npm','stage','publish',join(out,'package.tgz'),'--access','public','--ignore-scripts','--registry=https://registry.npmjs.org/']);
  const bytes=readFileSync(join(out,'package.tgz')), meta=JSON.parse(readFileSync(join(out,'metadata.json')));
  assert.deepEqual(readFileSync(join(root,'uploaded')),bytes);
  assert.equal(meta.sourceSha,SHA); assert.equal(meta.version,'9.9.9');
  for(const alg of ['sha256','sha512']) assert.equal(meta[alg],createHash(alg).update(bytes).digest('hex'));
  assert.ok(meta.files.includes('package/DESIGN.md'));
  assert.equal(meta.files.length,12);
  assert.ok(!JSON.stringify(meta).includes(TOKEN));
  assert.deepEqual(readdirSync(out).sort(),['metadata.json','package.tgz']);
  assert.deepEqual(readdirSync(join(root,'tmp')),[]);
});
for(const [label,env] of Object.entries({
  'no OIDC':{ACTIONS_ID_TOKEN_REQUEST_TOKEN:''}, 'wrong repo':{GITHUB_REPOSITORY:'other/pi-reach'},
  'wrong ref':{GITHUB_REF:'refs/heads/feature'}, 'not Actions':{GITHUB_ACTIONS:'false'},
  'NPM token':{NPM_TOKEN:TOKEN}, 'Node auth token':{NODE_AUTH_TOKEN:TOKEN},
  'old npm':{NPM_VERSION:'11.14.9'}, 'registry 500':{HTTP_STATUS:'500'},
  'network failure':{NETWORK_FAIL:'1'}, 'typecheck failure':{BUILD_FAIL:'1'},
  'pack failure':{PACK_FAIL:'1'}, 'wrong packed name':{BAD_NAME:'1'},
  'wrong packed version':{BAD_VERSION:'1'}, 'wrong exports':{BAD_EXPORT:'1'},
  'credential file':{BAD_FILE:'1'}, 'compiled test file':{BAD_DIST_TEST:'1'}, 'symlink':{BAD_LINK:'1'}, 'multiple tarballs':{TWO_TARS:'1'},
})) test(`${label} fails closed without uploading`,t=>{
  const root=fixture(t);
  const prepareFailure=Object.keys(env).some(key=>/^(BUILD|PACK|BAD|TWO)_/.test(key));
  const r=prepareFailure ? run(root,[],env) : stage(root,env);
  assert.notEqual(r.status,0); noUpload(root);
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
  assert.deepEqual(readdirSync(join(root,'tmp')),[]);
});
test('published version skips without building or uploading in stage',t=>{
  const root=fixture(t); success(stage(root,{HTTP_STATUS:'200'}));
  assert.deepEqual(calls(root).map(c=>c[0]),['git','npm','curl']);
});
test('real npm loader uses distinct empty private configs, ignores inherited paths and cleans on published skip',t=>{
  const root=fixture(t), poison=join(root,'inherited.npmrc');
  // 被读取就会因缺失环境变量而报错；文件仅含虚构值，不触及真实凭据。
  const content='//registry.npmjs.org/:_authToken=${FOUNDATION_MISSING_TEST_SECRET}\n';
  writeFileSync(poison,content);
  const result=stage(root,{HTTP_STATUS:'200',
    REAL_NPM:realpathSync(join(dirname(process.execPath),'npm')),NODE_DISABLE_COMPILE_CACHE:'1',
    NPM_CONFIG_USERCONFIG:poison,NPM_CONFIG_GLOBALCONFIG:poison,
    npm_config_userconfig:poison,npm_config_globalconfig:poison,
  });
  success(result);
  assert.doesNotMatch(result.stdout+result.stderr,/double-loading|FOUNDATION_MISSING_TEST_SECRET/);
  assert.deepEqual(calls(root).map(c=>c[0]),['git','npm','curl']);
  const [config]=readFileSync(join(root,'configs'),'utf8').trim().split('\n').map(JSON.parse);
  assert.notEqual(config.user,config.global);
  assert.equal(dirname(config.user),dirname(config.global));
  assert.ok(config.user.startsWith(join(root,'tmp','pwa-foundation-auth.')));
  assert.equal(config.userBytes,0); assert.equal(config.globalBytes,0);
  assert.equal(config.userMode,0o600); assert.equal(config.globalMode,0o600); assert.equal(config.dirMode,0o700);
  assert.equal(config.lowercaseUser,undefined); assert.equal(config.lowercaseGlobal,undefined);
  assert.equal(readFileSync(poison,'utf8'),content);
  assert.deepEqual(readdirSync(join(root,'tmp')),[]);
});
test('unknown arguments fail before any CLI and do not echo their value',t=>{
  const root=fixture(t), r=run(root,[TOKEN]); assert.notEqual(r.status,0); assert.deepEqual(calls(root),[]); assert.ok(!r.stderr.includes(TOKEN));
});
test('existing output directory is never reused or removed',t=>{
  const root=fixture(t), out=join(root,'artifact'); mkdirSync(out); writeFileSync(join(out,'keep'),'user');
  assert.notEqual(run(root,[],{PWA_FOUNDATION_PACK_DIR:out}).status,0); assert.equal(readFileSync(join(out,'keep'),'utf8'),'user'); noUpload(root);
});
test('ambiguous upload failure is not retried and reviewed artifact remains',t=>{
  const root=fixture(t), out=join(root,'artifact');
  assert.notEqual(stage(root,{UPLOAD_FAIL:'1'}).status,0);
  assert.equal(calls(root).filter(c=>c[1]==='stage').length,1);
  assert.ok(readFileSync(join(out,'metadata.json')).length);
  assert.deepEqual(readdirSync(out).sort(),['metadata.json','package.tgz']);
  assert.deepEqual(readdirSync(join(root,'tmp')),[]);
});
test('workflow has main gate, opt-in dispatch, isolated permissions, artifact retention and no tags/releases',()=>{
  const text=readFileSync(join(ROOT,'.github/workflows/pwa-foundation-npm.yml'),'utf8');
  assert.match(text,/branches: \[main\]/); assert.match(text,/type: boolean\s+default: false/);
  assert.match(text,/cancel-in-progress: false/); assert.match(text,/git cat-file -e/);
  assert.match(text,/previous.*!=.*current/); assert.match(text,/GITHUB_REPOSITORY.*yefengr\/pi-reach/);
  assert.equal((text.match(/id-token: write/g)||[]).length,1);
  assert.ok(text.indexOf('id-token: write')>text.indexOf('\n  stage:'));
  assert.doesNotMatch(text,/contents: write|environment:|npm publish|npm stage approve|npm whoami|npm install|git tag|gh release/);
  assert.match(text,/publish-npm\.sh --stage/); assert.match(text,/publish-npm\.sh\n/);
  const prepareJob=text.split('\n  prepare:')[1].split('\n  stage:')[0];
  const stageJob=text.split('\n  stage:')[1];
  assert.match(prepareJob,/permissions:\s+contents: read/);
  assert.doesNotMatch(prepareJob,/id-token:|if: needs.decide.outputs.stage/);
  assert.match(prepareJob,/uses: \.\/\.github\/actions\/setup-workspace/);
  assert.match(prepareJob,/sha256: \$\{\{ steps.pack.outputs.sha256 \}\}/);
  assert.match(stageJob,/needs: \[decide, prepare\]/);
  assert.match(stageJob,/actions\/setup-node@v7/);
  assert.match(stageJob,/actions\/download-artifact@v8/);
  assert.match(stageJob,/EXPECTED_SHA256: \$\{\{ needs.prepare.outputs.sha256 \}\}/);
  assert.match(stageJob,/EXPECTED_VERSION: \$\{\{ needs.prepare.outputs.version \}\}/);
  assert.doesNotMatch(stageJob,/setup-workspace|pnpm|install|upload-artifact/);
  const packStep=prepareJob.split('      - name: Validate and pack only')[1].split('      - uses: actions/upload-artifact@v6')[0];
  assert.match(packStep,/set -euo pipefail\s+bash packages\/pwa-foundation\/publish-npm\.sh\s+echo 'artifact-name=pwa-foundation-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}-\$\{\{ github.sha \}\}' >> "\$GITHUB_OUTPUT"/);
  assert.equal((text.match(/artifact-name=pwa-foundation-/g)||[]).length,1);
  assert.match(prepareJob,/artifact-name: \$\{\{ steps.pack.outputs.artifact-name \}\}/);
  assert.match(prepareJob,/actions\/upload-artifact@v6\s+with:\s+name: \$\{\{ steps.pack.outputs.artifact-name \}\}/);
  const downloadStep=stageJob.split('      - uses: actions/download-artifact@v8')[1].split('      - name:')[0];
  assert.match(downloadStep,/with:\s+name: \$\{\{ needs.prepare.outputs.artifact-name \}\}\n/);
  assert.doesNotMatch(downloadStep,/name:.*github.run_attempt/);
  assert.match(downloadStep,/path:.*github.run_attempt/);
  assert.match(stageJob,/ARTIFACT_NAME: \$\{\{ needs.prepare.outputs.artifact-name \}\}/);
  assert.match(stageJob,/set -euo pipefail\s+\[\[ -n "\$ARTIFACT_NAME" \]\]\s+bash packages\/pwa-foundation\/publish-npm\.sh --stage/);
});
for(const kind of ['external hash','missing hash','bad hash','expected version','metadata sha256','metadata sha512','metadata sourceSha','metadata version','metadata files','run SHA','checkout SHA','missing file','extra tarball','symlink tarball','symlink metadata','unprepared']) test(`${kind} rejects prepared artifact without mutation or upload`,t=>{
  const root=fixture(t), {out,env}=prepare(root);
  if(kind==='external hash') env.EXPECTED_SHA256='0'.repeat(64);
  if(kind==='missing hash') delete env.EXPECTED_SHA256;
  if(kind==='bad hash') env.EXPECTED_SHA256='invalid';
  if(kind==='expected version') env.EXPECTED_VERSION='1.2.3';
  if(kind.startsWith('metadata ')) {
    const field=kind.split(' ')[1], file=join(out,'metadata.json'), meta=JSON.parse(readFileSync(file));
    meta[field]=field==='files' ? [] : 'tampered'; writeFileSync(file,JSON.stringify(meta));
  }
  if(kind==='run SHA') env.GITHUB_SHA='b'.repeat(40);
  if(kind==='checkout SHA') { env.GITHUB_SHA='b'.repeat(40); const file=join(out,'metadata.json'), meta=JSON.parse(readFileSync(file)); meta.sourceSha=env.GITHUB_SHA; writeFileSync(file,JSON.stringify(meta)); }
  if(kind==='missing file') rmSync(join(out,'metadata.json'));
  if(kind==='extra tarball') copyFileSync(join(out,'package.tgz'),join(out,'extra.tgz'));
  if(kind.startsWith('symlink ')) {
    const file=join(out,kind==='symlink tarball' ? 'package.tgz' : 'metadata.json'), target=join(root,'external');
    copyFileSync(file,target); rmSync(file); symlinkSync(target,file);
  }
  if(kind==='unprepared') { rmSync(out,{recursive:true}); mkdirSync(out); }
  const before=readdirSync(out).map(file=>[file,readFileSync(join(out,file))]);
  assert.notEqual(run(root,['--stage',out],env).status,0); noUpload(root);
  assert.ok(!calls(root).some(c=>c[0]==='pnpm' || c[0]==='curl'));
  for(const [file,bytes] of before) assert.deepEqual(readFileSync(join(out,file)),bytes);
  assert.deepEqual(readdirSync(join(root,'tmp')),[]);
});
test('stage requires exactly one existing artifact directory and prepare outputs trusted bindings',t=>{
  const root=fixture(t);
  for(const args of [['--stage'],['--stage','missing'],['--stage','missing','extra']]) assert.notEqual(run(root,args,OIDC).status,0);
  noUpload(root);
  const output=join(root,'output'), {env}=prepare(root,{GITHUB_OUTPUT:output});
  assert.equal(readFileSync(output,'utf8'),`sha256=${env.EXPECTED_SHA256}\nversion=9.9.9\n`);
});
