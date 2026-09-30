import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startStaticPreview } from "./start-e2e-server.mjs";

async function createBuildFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-reach-vite-preview-"));
  const dist = join(root, "dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await Promise.all([
    writeFile(join(dist, "index.html"), "<!doctype html><title>Pi Reach preview</title>"),
    writeFile(join(dist, "assets", "app-D34DB33F.js"), "console.log('preview');"),
    writeFile(join(dist, "sw.js"), "self.addEventListener('fetch', () => {});"),
    writeFile(join(dist, "manifest.webmanifest"), "{}"),
  ]);
  return root;
}

/** @param {import("vite").PreviewServer} server */
function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.httpServer.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

test("starts and closes a Vite MPA preview for a built PWA", async () => {
  const root = await createBuildFixture();
  let server;

  try {
    server = await startStaticPreview({
      host: "127.0.0.1",
      port: 0,
      root,
    });

    const address = server.httpServer.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const rootResponse = await fetch(`${baseUrl}/`, { redirect: "manual" });
    assert.equal(rootResponse.status, 307);
    assert.equal(rootResponse.headers.get("location"), "/app");

    const app = await fetch(`${baseUrl}/app?pair=fixture`, { redirect: "manual" });
    assert.equal(app.status, 200);
    assert.equal(app.headers.get("cache-control"), "no-cache");
    assert.match(await app.text(), /Pi Reach preview/);

    const trailingSlash = await fetch(`${baseUrl}/app/?pair=fixture`, { redirect: "manual" });
    assert.equal(trailingSlash.status, 308);
    assert.equal(trailingSlash.headers.get("location"), "/app?pair=fixture");

    const directIndex = await fetch(`${baseUrl}/index.html`, { redirect: "manual" });
    assert.equal(directIndex.status, 307);
    assert.equal(directIndex.headers.get("location"), "/app");

    const serviceWorker = await fetch(`${baseUrl}/sw.js`);
    assert.equal(serviceWorker.status, 200);
    assert.equal(serviceWorker.headers.get("cache-control"), "no-cache");
    assert.match(serviceWorker.headers.get("content-type") ?? "", /^application\/javascript\b/);

    const manifest = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get("cache-control"), "no-cache");
    assert.match(manifest.headers.get("content-type") ?? "", /^application\/manifest\+json\b/);

    const asset = await fetch(`${baseUrl}/assets/app-D34DB33F.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

    const missingAsset = await fetch(`${baseUrl}/assets/missing.js`);
    assert.equal(missingAsset.status, 404);
    assert.equal(missingAsset.headers.get("cache-control"), null);

    const unknownPage = await fetch(`${baseUrl}/missing-page`);
    assert.equal(unknownPage.status, 404);

    const sourcePath = await fetch(`${baseUrl}/scripts/pwa-routing.mjs`);
    assert.equal(sourcePath.status, 404);

    const head = await fetch(`${baseUrl}/app`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("cache-control"), "no-cache");
    assert.equal(await head.text(), "");

    await closeServer(server);
    assert.equal(server.httpServer.listening, false);
    server = undefined;
    await assert.rejects(fetch(`${baseUrl}/app`));
  } finally {
    if (server?.httpServer.listening) await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid preview ports before startup", async () => {
  const root = await createBuildFixture();

  try {
    await assert.rejects(
      startStaticPreview({ root, port: "not-a-port" }),
      /Invalid PORT: not-a-port/,
    );
    await assert.rejects(
      startStaticPreview({ root, port: "0" }),
      /Invalid PORT: 0/,
    );
    await assert.rejects(
      startStaticPreview({ root, port: 65_536 }),
      /Invalid PORT: 65536/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires dist/index.html before starting preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reach-vite-preview-missing-"));

  try {
    await assert.rejects(
      startStaticPreview({ host: "127.0.0.1", port: 0, root }),
      new RegExp(`Missing production build file: ${join(root, "dist", "index.html")}`),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
