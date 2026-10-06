// 用法：node pwa/scripts/verify-runtime-image.mjs <已构建镜像> [production-relay] [staging-relay]
// 不构建、不拉取、不连接 Relay；所有容器必须使用同一已解析 image ID。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
assert(args.length >= 1 && args.length <= 3, "Expected image and optional production/staging Relay URLs");
const [image, production = "https://pi-reach-relay.yefengr.cn", staging = "https://staging.relay.example.test/self-hosted/ws?tenant=public&region=test"] = args;
assert.notEqual(production, staging, "Dual configuration must use distinct Relay URLs");
const containers = new Set();
const evidence = [];

function docker(arguments_, allowFailure = false) {
  const result = spawnSync("docker", arguments_, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (!allowFailure) assert.equal(result.status, 0, `Docker ${arguments_[0]} failed (exit ${result.status})`);
  return result;
}
function inspect(container) { return JSON.parse(docker(["inspect", container]).stdout)[0]; }
const imageId = docker(["image", "inspect", image, "--format", "{{.Id}}"] ).stdout.trim();
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
const imageUser = docker(["image", "inspect", imageId, "--format", "{{.Config.User}}"] ).stdout.trim();
assert(imageUser && !/^(?:root|0)(?::|$)/.test(imageUser), "Runtime image must declare a non-root user");

function run(extra = [], command = []) {
  const container = docker(["run", "--detach", "--pull=never", "--env", "PORT=3000", ...extra, imageId, ...command]).stdout.trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  containers.add(container);
  const metadata = inspect(container);
  assert.equal(metadata.Image, imageId, "A different image was used");
  return container;
}

function meta(html) {
  const values = [...html.matchAll(/<meta name="pi-reach-default-relay-url" content="([^"]*)"\s*\/?>/g)];
  assert.equal(values.length, 1, "Expected exactly one runtime Relay metadata entry");
  return values[0][1].replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

async function verifyServing(label, relay) {
  const env = relay === undefined ? [] : ["--env", `PI_REACH_DEFAULT_RELAY_URL=${relay}`];
  const container = run(["--publish", "127.0.0.1::3000", ...env]);
  const deadline = Date.now() + 90_000;
  let base;
  while (Date.now() < deadline) {
    const metadata = inspect(container);
    assert(metadata.State.Running, `${label} container refused startup`);
    const port = metadata.NetworkSettings.Ports["3000/tcp"]?.[0]?.HostPort;
    if (port) {
      base = `http://127.0.0.1:${port}`;
      try {
        const response = await fetch(`${base}/app`, { signal: AbortSignal.timeout(3_000) });
        if (response.ok) break;
      } catch { /* 等待本机 Nginx 就绪，不访问 Relay。 */ }
    }
    await sleep(300);
  }
  assert(base && Date.now() < deadline, `${label} container did not become ready`);
  const expected = relay ?? "https://pi-reach-relay.yefengr.cn";
  for (const path of ["/app", "/app/settings"]) {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200);
    assert.equal(meta(await response.text()), expected);
    assert.equal(response.headers.get("cache-control"), "no-cache");
  }
  assert.equal(inspect(container).Image, imageId);
  evidence.push({ case: label, imageId, defaultRelayUrl: expected });
}

async function verifyRefusal(label, extra, command = []) {
  const container = run(extra, command);
  const deadline = Date.now() + 15_000;
  let metadata;
  do {
    metadata = inspect(container);
    if (!metadata.State.Running) break;
    await sleep(200);
  } while (Date.now() < deadline);
  assert(!metadata.State.Running, `${label} unexpectedly started`);
  assert.notEqual(metadata.State.ExitCode, 0, `${label} unexpectedly succeeded`);
  const logs = docker(["logs", container]);
  assert.match(`${logs.stdout}${logs.stderr}`, /refusing startup/, `${label} did not reach runtime configuration rejection`);
  assert.equal(`${logs.stdout}${logs.stderr}`.includes("user:secret"), false);
  assert.equal(metadata.Image, imageId);
  evidence.push({ case: label, imageId, rejected: true });
}

try {
  await verifyServing("unset-production-default", undefined);
  await verifyServing("explicit-production", production);
  await verifyServing("explicit-staging", staging);
  for (const value of ["", "https://user:secret@relay.invalid", "https://relay.invalid/#fragment", "https://relay.invalid/\"<script>", "http://192.168.001.009:9000/relay", "https://192.168.001.001/relay", "https://[::ffff:192.168.001.009]/relay"]) {
    await verifyRefusal("invalid-configuration", ["--env", `PI_REACH_DEFAULT_RELAY_URL=${value}`]);
  }
  await verifyRefusal("missing-metadata", ["--entrypoint", "/bin/sh"], ["-c", "printf '<!doctype html><title>Missing runtime metadata</title>' > /usr/share/nginx/html/index.html; exec /docker-entrypoint.sh nginx -g 'daemon off;'"]);
  await verifyRefusal("read-only-injection", ["--read-only", "--entrypoint", "/docker-entrypoint.d/40-runtime-config.sh"]);
  console.log(JSON.stringify({ imageId, evidence }, null, 2));
} finally {
  for (const container of containers) docker(["rm", "--force", container]);
}
