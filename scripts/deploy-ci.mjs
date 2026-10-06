import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicUrl, smoke } from './deploy-smoke.mjs';

const COMPONENTS = ['relay', 'pwa'];
const DIGEST = 'sha256:[a-f0-9]{64}';

export function imageRef(value, prefix, component) {
  const repository = `${prefix}/pi-reach-${component}`;
  if (typeof value !== 'string' || !value.startsWith(`${repository}:`)) throw new Error(`Invalid ${component} repository`);
  const tail = value.slice(repository.length + 1);
  if (!new RegExp(`^v[0-9]+\\.[0-9]+\\.[0-9]+@${DIGEST}$`).test(tail)) throw new Error(`Invalid ${component} immutable image`);
  return value;
}

export function snapshotJson(value, prefix) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('Invalid deployment snapshot JSON'); }
  if (!parsed || Object.keys(parsed).sort().join(',') !== 'pwa,relay') throw new Error('Snapshot must contain both components');
  for (const component of COMPONENTS) {
    const metadata = parsed[component];
    if (!metadata || Object.keys(metadata).sort().join(',') !== 'image,revision' || typeof metadata.revision !== 'string' || !/^(?:[a-f0-9]{40,64})?$/.test(metadata.revision)) {
      throw new Error('Invalid snapshot metadata');
    }
    imageRef(metadata.image, prefix, component);
  }
  return parsed;
}

export function selectedComponents(env) {
  for (const name of ['SELECT_RELAY', 'SELECT_PWA']) {
    if (!['true', 'false'].includes(env[name])) throw new Error(`Missing or invalid ${name}`);
  }
  const selected = COMPONENTS.filter((component) => env[`SELECT_${component.toUpperCase()}`] === 'true');
  if (!selected.length) throw new Error('No selected components');
  return selected;
}

export function verifyCombination(current, tested, components = COMPONENTS) {
  for (const component of components) {
    if (current[component].image !== tested[component].image || current[component].revision !== tested[component].revision) {
      throw new Error(`${component} image/source drifted; a new staging run is required`);
    }
  }
}

function validateContext(env) {
  if (env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw new Error('Deployment only accepts a main commit');
  if (!/^ghcr\.io\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/.test(env.IMAGE_PREFIX ?? '')) throw new Error('Invalid IMAGE_PREFIX');
  publicUrl(env.PWA_URL, 'PWA_URL');
  publicUrl(env.RELAY_URL, 'RELAY_URL');
}

function desiredCombination(env, baseline, selected) {
  const desired = structuredClone(baseline);
  for (const component of selected) {
    desired[component] = { image: imageRef(env[`${component.toUpperCase()}_IMAGE`], env.IMAGE_PREFIX, component), revision: env.GITHUB_SHA };
  }
  return desired;
}

export async function deployStage({ mode, env, remote, runSmoke = smoke, note = () => {}, output = () => {}, published = () => false }) {
  validateContext(env);
  const selected = selectedComponents(env);
  if (mode === 'staging') {
    const baseline = snapshotJson(await remote('snapshot production'), env.IMAGE_PREFIX);
    const tested = desiredCombination(env, baseline, selected);
    // The first PWA capable of runtime configuration must itself be a candidate.
    // Smoke rejects an old production-default PWA if this is a later Relay-only run.
    for (const component of COMPONENTS) {
      await remote(`deploy ${component} ${tested[component].image}`);
      note(`staging ${component} deployed: ${tested[component].image}`);
    }
    verifyCombination(snapshotJson(await remote('snapshot staging'), env.IMAGE_PREFIX), tested);
    await runSmoke({ pwaUrl: env.PWA_URL, relayUrl: env.RELAY_URL });
    output('baseline', JSON.stringify(baseline));
    output('tested', JSON.stringify(tested));
    output('target', JSON.stringify({ pwaUrl: env.PWA_URL, relayUrl: env.RELAY_URL }));
    note(`staging endpoints: ${env.PWA_URL}; default Relay ${env.RELAY_URL}`);
    note(`staging passed for source ${env.GITHUB_SHA}; approve production only after real iOS and Android evidence for this run and digest.`);
    return tested;
  }
  if (mode !== 'production') throw new Error('Unknown deployment mode');
  let target;
  try { target = JSON.parse(env.STAGING_TARGET); } catch { throw new Error('Missing staging endpoint evidence'); }
  if (!target || Object.keys(target).sort().join(',') !== 'pwaUrl,relayUrl') throw new Error('Invalid staging endpoint evidence');
  const stagingOrigins = [publicUrl(target.pwaUrl, 'staging PWA').origin, publicUrl(target.relayUrl, 'staging Relay').origin];
  if ([publicUrl(env.PWA_URL, 'production PWA').origin, publicUrl(env.RELAY_URL, 'production Relay').origin].some((origin) => stagingOrigins.includes(origin))) {
    throw new Error('Staging and production endpoints must have distinct origins');
  }
  const baseline = snapshotJson(env.BASELINE, env.IMAGE_PREFIX);
  const tested = snapshotJson(env.TESTED, env.IMAGE_PREFIX);
  verifyCombination(tested, desiredCombination(env, baseline, selected));
  const current = snapshotJson(await remote('snapshot production'), env.IMAGE_PREFIX);
  const released = new Map(selected.map((component) => [component, published(component, tested[component].image)]));
  // A Release-only repair is allowed after every selected tag is verified and its
  // exact image is still live. It never writes Docker or treats stale staging as evidence.
  const releaseOnly = selected.every((component) => released.get(component));
  if (releaseOnly) verifyCombination(current, tested);
  else {
    verifyCombination(snapshotJson(await remote('snapshot staging'), env.IMAGE_PREFIX), tested);
    verifyCombination(current, baseline, COMPONENTS.filter((component) => !selected.includes(component)));
  }
  for (const component of selected) {
    if (released.get(component)) {
      verifyCombination(current, tested, [component]);
      note(`production ${component} already tagged and running the tested image; no redeployment`);
      continue;
    }
    if (current[component].image === tested[component].image && current[component].revision === tested[component].revision) {
      note(`production ${component} already running the tested image; rechecking before Release`);
      continue;
    }
    try { await remote(`deploy ${component} ${tested[component].image}`); }
    catch (error) {
      note(`production ${component} deployment failed: inspect the server for rollback status; earlier successful components may remain live`);
      throw error;
    }
    note(`production ${component} updated: ${tested[component].image}; later failure does not undo this component`);
  }
  verifyCombination(snapshotJson(await remote('snapshot production'), env.IMAGE_PREFIX), tested);
  await runSmoke({ pwaUrl: env.PWA_URL, relayUrl: env.RELAY_URL });
  note(`production checks passed for source ${env.GITHUB_SHA}; exact staging digests are live.`);
  return tested;
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${binary} command failed; no further deployment or Release steps will run`);
  return result.stdout.trim();
}

function sshRemote(env) {
  for (const name of ['DEPLOY_SSH_KEY', 'DEPLOY_KNOWN_HOSTS', 'DEPLOY_HOST', 'DEPLOY_USER', 'RUNNER_TEMP']) {
    if (!env[name]) throw new Error(`Environment is missing ${name}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(env.DEPLOY_HOST) || !/^[A-Za-z0-9._-]+$/.test(env.DEPLOY_USER) || !/^\d+$/.test(env.DEPLOY_PORT ?? '22') || Number(env.DEPLOY_PORT ?? '22') < 1 || Number(env.DEPLOY_PORT ?? '22') > 65535) {
    throw new Error('Invalid SSH destination');
  }
  const root = mkdtempSync(join(env.RUNNER_TEMP, 'pi-reach-deploy-'));
  chmodSync(root, 0o700);
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); });
  writeFileSync(join(root, 'key'), `${env.DEPLOY_SSH_KEY}\n`, { mode: 0o600 });
  writeFileSync(join(root, 'known_hosts'), `${env.DEPLOY_KNOWN_HOSTS}\n`, { mode: 0o600 });
  const args = ['-i', join(root, 'key'), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${join(root, 'known_hosts')}`, '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-p', env.DEPLOY_PORT || '22', `${env.DEPLOY_USER}@${env.DEPLOY_HOST}`];
  return { remote: (request) => command('ssh', [...args, request]), cleanup };
}

// An existing tag is only useful for repairing this run's Release, never proof of
// testing a different digest. Resolve annotated tags to their source commit.
function publishedForSource(component, image, env) {
  const version = image.split(':v')[1].split('@')[0];
  const ref = `repos/${env.GITHUB_REPOSITORY}/git/ref/tags/${component}-v${version}`;
  const result = spawnSync('gh', ['api', ref], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) {
    if (result.stderr?.includes('HTTP 404')) return false;
    throw new Error('Unable to verify the published tag');
  }
  let object = JSON.parse(result.stdout).object;
  if (object.type === 'tag') object = JSON.parse(command('gh', ['api', `repos/${env.GITHUB_REPOSITORY}/git/tags/${object.sha}`])).object;
  if (object.type !== 'commit' || object.sha !== env.GITHUB_SHA) throw new Error('Published tag belongs to another source commit');
  return true;
}

async function main() {
  const env = process.env;
  const note = (message) => {
    console.log(message);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${message}\n`);
  };
  validateContext(env);
  const ssh = sshRemote(env);
  try {
    await deployStage({ mode: process.argv[2], env, remote: ssh.remote,
      published: (component, image) => publishedForSource(component, image, env), note,
      output: (name, value) => appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`) });
  } finally { ssh.cleanup(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
