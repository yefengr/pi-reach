import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const repo = process.cwd();
const root = path.join(repo, '.pi/tmp/pwa-production-ab');
const require = createRequire(path.join(repo, 'pwa/package.json'));
const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve('vite')).href);
const versions = {
  before: 'a3a87693d8c8d19d66e15da2da8f9ade343bd42c',
  after: 'f15d266bbf95b24a0138e1dae9bcc517fc69211a',
};
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputs = ['pwa', 'packages/protocol', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.node-version'];
const fixtureFiles = ['bootstrap.tsx', 'transports.ts', 'history.ts'].filter(name => fs.existsSync(path.join(root, 'fixtures', name)));
if (!fixtureFiles.includes('bootstrap.tsx') || !fixtureFiles.includes('transports.ts')) throw new Error('Fixture is not ready');
const sharedDiff = git(['diff', versions.before, versions.after, '--', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/protocol', 'pwa/package.json']);
if (sharedDiff) throw new Error('Dependencies or protocol differ between versions');
function link(target, destination) {
  if (fs.existsSync(destination)) {
    if (!fs.lstatSync(destination).isSymbolicLink() || fs.realpathSync(destination) !== fs.realpathSync(target)) throw new Error(`Unexpected existing dependency entry: ${destination}`);
    return;
  }
  fs.symlinkSync(target, destination, 'dir');
}
const manifests = {};
process.env.NODE_ENV = 'production';
for (const [name, ref] of Object.entries(versions)) {
  const dir = path.join(root, 'versions', name);
  const marker = path.join(dir, 'snapshot.json');
  if (!fs.existsSync(marker)) {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.readdirSync(dir).length) throw new Error(`Snapshot directory is not empty: ${name}`);
    const archive = execFileSync('git', ['archive', '--format=tar', ref, ...inputs], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
    const extraction = spawnSync('tar', ['-xf', '-', '-C', dir], { input: archive, encoding: 'utf8' });
    if (extraction.status !== 0) throw new Error(extraction.stderr || 'Snapshot extraction failed');
    fs.writeFileSync(marker, JSON.stringify({ ref, tree: git(['rev-parse', `${ref}^{tree}`]) }));
  } else if (JSON.parse(fs.readFileSync(marker, 'utf8')).ref !== ref) throw new Error('Snapshot ref mismatch');
  link(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'));
  link(path.join(repo, 'pwa/node_modules'), path.join(dir, 'pwa/node_modules'));
  const pwa = path.join(dir, 'pwa');
  const fixture = path.join(pwa, '__ab');
  fs.mkdirSync(fixture, { recursive: true });
  for (const file of fixtureFiles) fs.copyFileSync(path.join(root, 'fixtures', file), path.join(fixture, file));
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(pwa, 'vite.config.ts'), pwa);
  if (!loaded) throw new Error('Vite configuration was not loaded');
  const config = loaded.config;
  const transports = path.join(fixture, 'transports.ts');
  await build({
    ...config, configFile: false, root: pwa, mode: 'production',
    define: { ...config.define, __AB_REVISION__: JSON.stringify(ref) },
    resolve: { ...config.resolve, alias: [
      { find: /^@\/lib\/pi-reach\/relay-client$/, replacement: transports },
      { find: /^@\/lib\/pi-reach\/peer-channel$/, replacement: transports },
      { find: '@', replacement: path.join(pwa, 'src') },
    ] },
    plugins: [...config.plugins, {
      name: 'isolated-ab-entry',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          return html.replace('src="/src/main.tsx"', 'src="/__ab/bootstrap.tsx"')
            .replace(/(<meta name="pi-reach-default-relay-url" content=")[^"]+("\s*\/?>)/, '$1https://relay.example.test$2');
        },
      },
    }],
    build: { ...config.build, outDir: 'dist', emptyOutDir: true, sourcemap: true },
  });
  const assets = fs.readdirSync(path.join(pwa, 'dist/assets')).filter(file => file.endsWith('.js'));
  const mapSources = assets.flatMap(file => JSON.parse(fs.readFileSync(path.join(pwa, 'dist/assets', `${file}.map`), 'utf8')).sources);
  const productionReact = mapSources.some(source => /react(?:-dom[^/]*)?\/.*production/.test(source));
  if (!productionReact || mapSources.some(source => /react(?:-dom[^/]*)?\/.*development/.test(source))) throw new Error('React production compilation could not be confirmed');
  const ownSources = [...new Set(mapSources.filter(source => source.includes('/src/') && !source.includes('node_modules')))];
  if (!ownSources.some(source => source.endsWith('/components/pwa/pwa-app.tsx'))) throw new Error('Real PwaApp is absent');
  if (!mapSources.some(source => source.endsWith('/__ab/bootstrap.tsx')) || mapSources.some(source => source.endsWith('/src/main.tsx'))) throw new Error('Isolated production entry was not injected');
  manifests[name] = {
    revision: ref, tree: git(['rev-parse', `${ref}^{tree}`]), productionReact,
    fixtureHashes: Object.fromEntries(fixtureFiles.map(file => [file, hash(path.join(fixture, file))])),
    realPwaApp: true, isolatedEntry: true, sourceModuleCount: ownSources.length,
    assets: assets.map(file => ({ file, bytes: fs.statSync(path.join(pwa, 'dist/assets', file)).size, sha256: hash(path.join(pwa, 'dist/assets', file)) })),
  };
}
if (JSON.stringify(manifests.before.fixtureHashes) !== JSON.stringify(manifests.after.fixtureHashes)) throw new Error('Fixture differs between variants');
fs.writeFileSync(path.join(root, 'build-manifest.json'), JSON.stringify({ versions: manifests, lockfileSha256: hash(path.join(repo, 'pnpm-lock.yaml')) }, null, 2));
console.log(JSON.stringify({ success: true, versions: manifests }, null, 2));
