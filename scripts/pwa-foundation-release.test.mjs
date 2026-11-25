import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'packages/pwa-foundation/publish-npm.sh');
const TOKEN = 'secret-that-must-not-leak';
const OIDC = { GITHUB_ACTIONS:'true', GITHUB_REPOSITORY:'yefengr/pi-reach', GITHUB_REF:'refs/heads/main', ACTIONS_ID_TOKEN_REQUEST_URL:'https://example.invalid', ACTIONS_ID_TOKEN_REQUEST_TOKEN:TOKEN };
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
  for(const key of [...Object.keys(OIDC),'NPM_TOKEN','NODE_AUTH_TOKEN','PWA_FOUNDATION_PACK_DIR','NPM_CONFIG_USERCONFIG','NPM_CONFIG_GLOBALCONFIG','npm_config_userconfig','npm_config_globalconfig','REAL_NPM']) delete env[key];
  return spawnSync('/bin/bash',[join(root,'publish-npm.sh'),...args],{encoding:'utf8',env:{...env,PATH:`${join(root,'bin')}:${process.env.PATH}`,TMPDIR:join(root,'tmp'),FAKE_ROOT:root,...extra}});
}
function calls(root) { return readFileSync(join(root,'calls'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
function success(r) { assert.equal(r.status,0,r.stdout+r.stderr); assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN)); }
function noUpload(root) { assert.ok(!calls(root).some(c=>c[0]==='npm' && c[1]!=='--version')); }
test('default validates and packs once, never contacts registry/upload; temporary directory is cleaned',t=>{
  const root=fixture(t); success(run(root));
  assert.deepEqual(calls(root).map(c=>c.slice(0,2)),[['pnpm','--filter'],['pnpm','pack'],['git','rev-parse']]);
  assert.deepEqual(readdirSync(join(root,'tmp')),[]);
});
test('OIDC uploads exactly the inspected tarball once and retains verifiable safe metadata',t=>{
  const root=fixture(t), out=join(root,'artifact'); success(run(root,['--stage'],{...OIDC,PWA_FOUNDATION_PACK_DIR:out}));
  const log=calls(root);
  assert.deepEqual(log.map(c=>c[0]),['npm','curl','pnpm','pnpm','git','npm']);
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
  const root=fixture(t), r=run(root,['--stage'],{...OIDC,...env});
  assert.notEqual(r.status,0); noUpload(root);
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
  assert.deepEqual(readdirSync(join(root,'tmp')),[]);
});
test('published version skips before building or uploading',t=>{
  const root=fixture(t); success(run(root,['--stage'],{...OIDC,HTTP_STATUS:'200'}));
  assert.deepEqual(calls(root).map(c=>c[0]),['npm','curl']);
});
test('real npm loader uses distinct empty private configs, ignores inherited paths and cleans on published skip',t=>{
  const root=fixture(t), poison=join(root,'inherited.npmrc');
  // 被读取就会因缺失环境变量而报错；文件仅含虚构值，不触及真实凭据。
  const content='//registry.npmjs.org/:_authToken=${FOUNDATION_MISSING_TEST_SECRET}\n';
  writeFileSync(poison,content);
  const result=run(root,['--stage'],{...OIDC,HTTP_STATUS:'200',
    REAL_NPM:realpathSync(join(dirname(process.execPath),'npm')),NODE_DISABLE_COMPILE_CACHE:'1',
    NPM_CONFIG_USERCONFIG:poison,NPM_CONFIG_GLOBALCONFIG:poison,
    npm_config_userconfig:poison,npm_config_globalconfig:poison,
  });
  success(result);
  assert.doesNotMatch(result.stdout+result.stderr,/double-loading|FOUNDATION_MISSING_TEST_SECRET/);
  assert.deepEqual(calls(root).map(c=>c[0]),['npm','curl']);
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
  assert.notEqual(run(root,['--stage'],{...OIDC,UPLOAD_FAIL:'1',PWA_FOUNDATION_PACK_DIR:out}).status,0);
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
  assert.match(text,/uses: \.\/\.github\/actions\/setup-workspace/);
});
