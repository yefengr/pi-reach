import { pathToFileURL } from 'node:url';

const REQUEST_TIMEOUT_MS = 30_000;
const WEBSOCKET_TIMEOUT_MS = 15_000;

export function publicUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error(`${name} must be a public HTTPS URL without credentials, query or fragment`);
  }
  return url;
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match?.[2]?.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function runtimeRelay(html) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const matches = tags.filter((tag) => attribute(tag, 'name') === 'pi-reach-default-relay-url');
  if (matches.length !== 1) throw new Error('PWA runtime Relay metadata must occur exactly once');
  return publicUrl(attribute(matches[0], 'content'), 'PWA runtime Relay').href.replace(/\/$/, '');
}

export function checkCache(response, immutable = false) {
  const value = response.headers.get('cache-control') ?? '';
  if (immutable ? !value.includes('immutable') || !/max-age=[1-9]\d*/.test(value) : !value.includes('no-cache')) {
    throw new Error('Unexpected cache response headers');
  }
}

export async function websocketChallenge(url, WebSocketClass = WebSocket) {
  const endpoint = new URL(url);
  endpoint.protocol = 'wss:';
  await new Promise((resolve, reject) => {
    const socket = new WebSocketClass(endpoint);
    const finish = (error) => {
      clearTimeout(timer);
      socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Relay WebSocket challenge timed out')), WEBSOCKET_TIMEOUT_MS);
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.type !== 'challenge' || typeof frame.nonce !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.nonce) || Buffer.from(frame.nonce, 'base64').length !== 32) {
          throw new Error('Relay WebSocket did not return a valid challenge');
        }
        finish();
      } catch { finish(new Error('Relay WebSocket did not return a valid challenge')); }
    };
    socket.onerror = () => finish(new Error('Relay WebSocket connection failed'));
    socket.onclose = () => finish(new Error('Relay WebSocket closed before the challenge'));
  });
}

export async function smoke({ pwaUrl, relayUrl, fetcher = fetch, challenge = websocketChallenge }) {
  const pwa = publicUrl(pwaUrl, 'PWA_URL');
  const relay = publicUrl(relayUrl, 'RELAY_URL');
  if (pwa.pathname !== '/app' || pwa.origin === relay.origin) throw new Error('PWA_URL must end in /app and use a separate origin from Relay');
  const get = async (url, status = 200) => {
    const response = await fetcher(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'manual' });
    if (response.status !== status || (response.url && new URL(response.url).href !== new URL(url).href)) {
      throw new Error(`Unexpected HTTP response for ${new URL(url).pathname}`);
    }
    return response;
  };
  const page = await get(pwa);
  checkCache(page);
  if (!(page.headers.get('content-type') ?? '').includes('text/html')) throw new Error('PWA did not return HTML');
  const html = await page.text();
  if (runtimeRelay(html) !== relay.href.replace(/\/$/, '')) throw new Error('PWA runtime Relay does not match the target environment');
  const settings = await get(new URL('/app/settings', pwa));
  checkCache(settings);
  if (runtimeRelay(await settings.text()) !== runtimeRelay(html)) throw new Error('PWA route runtime configuration differs');
  const worker = await get(new URL('/sw.js', pwa));
  checkCache(worker);
  if (!/javascript/.test(worker.headers.get('content-type') ?? '')) throw new Error('Worker content type is invalid');
  if (!(await worker.text()).length) throw new Error('Worker is empty');
  const manifest = await get(new URL('/manifest.webmanifest', pwa));
  checkCache(manifest);
  const manifestJson = await manifest.json();
  if (manifestJson.start_url !== '/app' || manifestJson.scope !== '/app') throw new Error('Manifest application routes are invalid');
  const assets = [...html.matchAll(/\b(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((match) => match[1]);
  if (!assets.some((asset) => asset.endsWith('.js')) || !assets.some((asset) => asset.endsWith('.css'))) throw new Error('PWA entry has no production JS/CSS assets');
  for (const asset of new Set(assets)) checkCache(await get(new URL(asset, pwa)), true);
  for (const pathname of ['/assets/pi-reach-smoke-missing.js', '/pi-reach-smoke-missing', '/.env']) {
    await get(new URL(pathname, pwa), 404);
  }
  const healthUrl = new URL(`${relay.pathname.replace(/\/$/, '')}/health`, relay);
  if ((await (await get(healthUrl)).text()).trim() !== 'OK') throw new Error('Relay health response is invalid');
  await challenge(relay);
  return { pwa: pwa.href, relay: relay.href, checks: 'HTTPS/routes/cache/runtime/assets/worker/manifest/404/WebSocket' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  smoke({ pwaUrl: process.env.PWA_URL, relayUrl: process.env.RELAY_URL })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
