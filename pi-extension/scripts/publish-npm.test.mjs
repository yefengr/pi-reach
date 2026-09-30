import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "publish-npm.sh");
const TOKEN = "npm-token-must-not-leak";
const OIDC_ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example.invalid/request",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fake-request-token",
};

// Fake npm/pnpm: record every call and simulate a registry where 9.9.9 is not published yet.
const FAKE_CLI = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const state = process.env.FAKE_STATE_DIR;
const userconfig = process.env.NPM_CONFIG_USERCONFIG;
fs.appendFileSync(path.join(state, "calls.jsonl"), JSON.stringify({
  name,
  args,
  npmrc: userconfig && fs.existsSync(userconfig) ? fs.readFileSync(userconfig, "utf8") : null,
}) + "\n");
const publishedMarker = path.join(state, "published");

if (name === "pnpm" && args[0] === "verify") process.exit(0);
if (name === "pnpm" && args[0] === "pack") {
  const filename = path.join(args[args.indexOf("--pack-destination") + 1], "yefengr-pi-reach-9.9.9.tgz");
  fs.writeFileSync(filename, "fake tarball");
  process.stdout.write(JSON.stringify({ filename, files: [{ path: "dist/index.js" }] }) + "\n");
  process.exit(0);
}
if (name === "npm" && args[0] === "--version") {
  process.stdout.write((process.env.FAKE_NPM_VERSION || "11.19.0") + "\n");
  process.exit(0);
}
if (name === "npm" && args[0] === "whoami") process.exit(process.env.FAKE_NPM_LOGGED_IN === "1" ? 0 : 1);
if (name === "npm" && args[0] === "view") {
  if (process.env.FAKE_ALREADY_PUBLISHED === "1" || fs.existsSync(publishedMarker)) {
    process.stdout.write("9.9.9\n");
    process.exit(0);
  }
  process.stderr.write("npm error code E404\n");
  process.exit(1);
}
if (name === "npm" && args[0] === "publish") {
  fs.writeFileSync(publishedMarker, "");
  process.exit(0);
}
if (name === "npm" && args[0] === "stage" && args[1] === "publish") process.exit(0);
process.stderr.write("unhandled fake command: " + name + " " + args.join(" ") + "\n");
process.exit(90);
`;

function makeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-reach-publish-test-"));
  const fakeBin = join(root, "fake-bin");
  const tmp = join(root, "tmp");
  mkdirSync(fakeBin);
  mkdirSync(tmp);
  copyFileSync(SCRIPT, join(root, "publish-npm.sh"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@yefengr/pi-reach", version: "9.9.9" }));
  writeFileSync(join(root, "calls.jsonl"), "");
  for (const command of ["npm", "pnpm"]) {
    writeFileSync(join(fakeBin, command), FAKE_CLI);
    chmodSync(join(fakeBin, command), 0o755);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, fakeBin, tmp };
}

function run(fixture, args = [], extraEnv = {}) {
  const env = { ...process.env };
  // The real shell or CI job may carry credentials; each test sets its own authentication.
  for (const key of ["NPM_TOKEN", "NPM_CONFIG_USERCONFIG", "npm_config_userconfig", ...Object.keys(OIDC_ENV)]) delete env[key];
  return spawnSync("/bin/bash", [join(fixture.root, "publish-npm.sh"), ...args], {
    encoding: "utf8",
    input: "",
    env: { ...env, PATH: `${fixture.fakeBin}:${process.env.PATH}`, TMPDIR: fixture.tmp, FAKE_STATE_DIR: fixture.root, ...extraEnv },
  });
}

function calls(fixture) {
  return readFileSync(join(fixture.root, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function commandLines(fixture) {
  return calls(fixture).map((call) => [call.name, ...call.args].join(" "));
}

function assertSucceeded(result) {
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

test("stages the inspected tarball through GitHub Actions OIDC without a token, login check or OTP prompt", (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, ["--stage"], OIDC_ENV);
  assertSucceeded(result);
  const lines = commandLines(fixture);
  const packDir = lines[3]?.split(" --pack-destination ")[1];
  assert.ok(packDir?.startsWith(join(fixture.tmp, "pi-reach-pack.")), lines.join("\n"));
  assert.deepEqual(lines, [
    "npm --version",
    "npm view @yefengr/pi-reach@9.9.9 version --registry=https://registry.npmjs.org/",
    "pnpm verify",
    `pnpm pack --json --pack-destination ${packDir}`,
    `npm stage publish ${join(packDir, "yefengr-pi-reach-9.9.9.tgz")} --access public --ignore-scripts`,
  ]);
  assert.ok(calls(fixture).every((call) => call.npmrc === null));
  assert.doesNotMatch(result.stdout, /OTP/);
  assert.match(result.stdout, /已提交到 npm 待审区：@yefengr\/pi-reach@9\.9\.9/);
  assert.deepEqual(readdirSync(fixture.tmp), [], "the pack directory is removed");
});

test("refuses to stage with an npm CLI older than 11.15.0", (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, ["--stage"], { ...OIDC_ENV, FAKE_NPM_VERSION: "11.14.2" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /需要 npm 11\.15\.0 或更高版本，当前为 11\.14\.2/);
  assert.deepEqual(commandLines(fixture), ["npm --version"]);
});

test("refuses to upload a version that already exists on npm", (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, ["--stage"], { ...OIDC_ENV, FAKE_ALREADY_PUBLISHED: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@yefengr\/pi-reach@9\.9\.9 已存在/);
  assert.ok(commandLines(fixture).every((line) => !line.startsWith("pnpm") && !line.startsWith("npm stage")));
});

test("requires an authenticated npm session without a token or OIDC", (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, ["--stage"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /当前 npm 会话未认证/);
  assert.deepEqual(commandLines(fixture), ["npm --version", "npm whoami --registry=https://registry.npmjs.org/"]);
});

test("publishes directly with NPM_TOKEN through a temporary npmrc and confirms the version", (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, [], { NPM_TOKEN: TOKEN, FAKE_NPM_LOGGED_IN: "1" });
  assertSucceeded(result);
  const upload = calls(fixture).find((call) => call.name === "npm" && call.args[0] === "publish");
  assert.deepEqual(upload.args.slice(2), ["--access", "public", "--ignore-scripts"]);
  assert.match(upload.npmrc, /^\/\/registry\.npmjs\.org\/:_authToken=\$\{NPM_TOKEN\}$/m);
  for (const call of calls(fixture)) {
    assert.ok(!JSON.stringify(call).includes(TOKEN), "the token never reaches arguments or the npmrc file");
  }
  assert.ok(!commandLines(fixture).some((line) => line.startsWith("npm stage")));
  assert.match(result.stdout, /发布成功：@yefengr\/pi-reach@9\.9\.9/);
  assert.deepEqual(readdirSync(fixture.tmp), [], "the temporary npmrc and pack directory are removed");
});

test("rejects unknown arguments before touching npm", (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, ["--dry-run"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /未知参数：--dry-run/);
  assert.deepEqual(commandLines(fixture), []);
});
