import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { pwaRoutingPlugin } from "./pwa-routing.mjs";

const INDEX_HTML = '<!doctype html><title>Pi Reach</title><meta name="pi-reach-default-relay-url" content="https://staging.example.test/relay?tenant=one&amp;region=two" />';
const ASSET_SOURCE = "console.log('pi-reach');";

function fixtureStaticMiddleware(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const fixtures = new Map([
    ["/index.html", ["text/html; charset=utf-8", INDEX_HTML]],
    ["/assets/app-D34DB33F.js", ["text/javascript; charset=utf-8", ASSET_SOURCE]],
    ["/sw.js", ["text/plain", "service-worker"]],
    ["/manifest.webmanifest", ["text/plain", "{}"]],
  ]);
  const fixture = fixtures.get(url.pathname);

  if (!fixture) {
    response.statusCode = 404;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end(request.method === "HEAD" ? undefined : "Not found");
    return;
  }

  const [contentType, body] = fixture;
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType);
  response.setHeader("X-Rewritten-Url", request.url ?? "");
  response.end(request.method === "HEAD" ? undefined : body);
}

async function startFixtureServer() {
  const plugin = pwaRoutingPlugin();
  assert.equal(typeof plugin.configureServer, "function");
  assert.equal(typeof plugin.configurePreviewServer, "function");

  const middlewares = [];
  plugin.configurePreviewServer({
    middlewares: {
      use(middleware) {
        middlewares.push(middleware);
      },
    },
  });

  const server = createServer((request, response) => {
    let index = 0;
    const next = () => {
      const middleware = middlewares[index];
      index += 1;
      if (middleware) middleware(request, response, next);
      else fixtureStaticMiddleware(request, response);
    };
    next();
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    }),
  };
}

async function request(baseUrl, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    ...options,
  });
}

test("applies the shared PWA routing and cache contract over HTTP", async () => {
  const fixture = await startFixtureServer();

  try {
    const root = await request(fixture.baseUrl, "/?pair=one");
    assert.equal(root.status, 307);
    assert.equal(root.headers.get("location"), "/app?pair=one");

    const app = await request(fixture.baseUrl, "/app?pair=two");
    assert.equal(app.status, 200);
    assert.equal(app.headers.get("x-rewritten-url"), "/index.html?pair=two");
    assert.equal(app.headers.get("cache-control"), "no-cache");
    assert.match(app.headers.get("content-type") ?? "", /^text\/html\b/);
    assert.equal(await app.text(), INDEX_HTML);

    const precachedApp = await request(fixture.baseUrl, "/app?__WB_REVISION__=build-hash");
    assert.equal(precachedApp.status, 200);
    assert.equal(precachedApp.headers.get("cache-control"), "no-cache");
    assert.equal(await precachedApp.text(), INDEX_HTML);

    const settings = await request(fixture.baseUrl, "/app/settings?pair=five");
    assert.equal(settings.status, 200);
    assert.equal(settings.headers.get("x-rewritten-url"), "/index.html?pair=five");
    assert.equal(settings.headers.get("cache-control"), "no-cache");
    assert.equal(await settings.text(), INDEX_HTML);

    const unknownAppPath = await request(fixture.baseUrl, "/app/unknown/nested");
    assert.equal(unknownAppPath.status, 200);
    assert.equal(await unknownAppPath.text(), INDEX_HTML);

    const trailingSlash = await request(fixture.baseUrl, "/app/?pair=three");
    assert.equal(trailingSlash.status, 308);
    assert.equal(trailingSlash.headers.get("location"), "/app?pair=three");

    const directIndex = await request(fixture.baseUrl, "/index.html?pair=four");
    assert.equal(directIndex.status, 307);
    assert.equal(directIndex.headers.get("location"), "/app?pair=four");

    const serviceWorker = await request(fixture.baseUrl, "/sw.js");
    assert.equal(serviceWorker.status, 200);
    assert.equal(serviceWorker.headers.get("cache-control"), "no-cache");
    assert.match(serviceWorker.headers.get("content-type") ?? "", /^application\/javascript\b/);

    const manifest = await request(fixture.baseUrl, "/manifest.webmanifest");
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get("cache-control"), "no-cache");
    assert.match(manifest.headers.get("content-type") ?? "", /^application\/manifest\+json\b/);

    const asset = await request(fixture.baseUrl, "/assets/app-D34DB33F.js");
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(await asset.text(), ASSET_SOURCE);

    const missingAsset = await request(fixture.baseUrl, "/assets/missing.js");
    assert.equal(missingAsset.status, 404);
    assert.equal(missingAsset.headers.get("cache-control"), null);
    assert.notEqual(await missingAsset.text(), INDEX_HTML);

    const unknownPage = await request(fixture.baseUrl, "/unknown");
    assert.equal(unknownPage.status, 404);
    assert.equal(unknownPage.headers.get("cache-control"), null);

    const head = await request(fixture.baseUrl, "/app?head=true", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("cache-control"), "no-cache");
    assert.equal(await head.text(), "");
  } finally {
    await fixture.close();
  }
});
