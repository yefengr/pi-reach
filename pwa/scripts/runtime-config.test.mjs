import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../docker-entrypoint.d/40-runtime-config.sh", import.meta.url));
const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
const metaPattern = /<meta name="pi-reach-default-relay-url" content="([^"]*)"\s*\/?>/g;
const production = "https://pi-reach-relay.yefengr.cn";
const validUrls = [production, "https://staging.example.test/relay/ws?tenant=one&region=two", "http://127.0.0.1:9000/relay", "wss://[::1]:9000/relay?public='value'", "https://[::ffff:192.0.2.1]/a%20b"];
const invalidUrls = ["", " https://relay.test", "https://relay.test\n", "ftp://relay.test", "https://user:secret@relay.test", "https://@relay.test", "https://relay.test/#fragment", "https://relay.test/\"<script>", "https://relay.test/\\evil", "https://relay.test/%zz", "https://relay.test:70000", "https://[bad]", "https://[:1::]", "https://relay.test:", "https://256.0.0.1", "https://relay..test", "https://relay.123", "http://192.168.001.009:9000/relay", "https://192.168.001.001/relay", "https://[::ffff:192.168.001.009]/relay"];

async function fixture(run) {
  const base = new URL("../../.pi/tmp/", import.meta.url);
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL("runtime-config-", base)));
  const index = `${directory}/index.html`;
  await writeFile(index, source);
  const inject = (value) => {
    const env = { ...process.env };
    delete env.PI_REACH_DEFAULT_RELAY_URL;
    if (value !== undefined) env.PI_REACH_DEFAULT_RELAY_URL = value;
    return spawnSync("/bin/sh", [script, "--fixture", index], { env, encoding: "utf8" });
  };
  try { await run({ directory, index, inject }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function decodeAttribute(value) { return value.replaceAll("&#39;", "'").replaceAll("&amp;", "&"); }

for (const value of [undefined, ...validUrls]) {
  test("injects a public default atomically, retaining paths and escaping HTML attributes", async () => {
    await fixture(async ({ directory, index, inject }) => {
      const result = inject(value);
      assert.equal(result.status, 0, result.stderr);
      const html = await readFile(index, "utf8");
      const matches = [...html.matchAll(metaPattern)];
      assert.equal(matches.length, 1);
      assert.equal(decodeAttribute(matches[0][1]), value ?? production);
      assert.equal(html.replace(metaPattern, ""), source.replace(metaPattern, ""));
      assert.deepEqual(await readdir(directory), ["index.html"]);
      assert.equal(inject(value).status, 0, "restart must be idempotent");
    });
  });
}
for (const value of invalidUrls) {
  test("rejects invalid or explicitly empty defaults without disclosing their content", async () => {
    await fixture(async ({ directory, index, inject }) => {
      const result = inject(value);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /refusing startup/);
      assert.equal(result.stderr.includes("user:secret"), false);
      assert.equal(await readFile(index, "utf8"), source);
      assert.deepEqual(await readdir(directory), ["index.html"]);
    });
  });
}

test("rejects missing, duplicate or non-injectable metadata without replacing the entry", async () => {
  await fixture(async ({ directory, index, inject }) => {
    for (const html of [source.replace(metaPattern, ""), source.replace("</head>", '<meta name="pi-reach-default-relay-url" content="https://duplicate.test" /></head>'), source.replace("</head>", "<meta name='pi-reach-default-relay-url' content='https://duplicate.test' /></head>")]) {
      await writeFile(index, html);
      const result = inject(production);
      assert.notEqual(result.status, 0);
      assert.equal(await readFile(index, "utf8"), html);
      assert.deepEqual(await readdir(directory), ["index.html"]);
    }
    await rm(index);
    assert.notEqual(inject(production).status, 0);
    await mkdir(index);
    assert.notEqual(inject(production).status, 0);
  });
});
