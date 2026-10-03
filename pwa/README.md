# Pi Reach PWA

React browser PWA for remotely controlling Pi coding agents, built with Vite.

## Routes

- `/app` — browser workspace and the only product route.
- `/` — HTTP 307 redirect to `/app`, also used by the Docker healthcheck.
- Missing pages and assets return 404; there is no general SPA fallback.

The PWA uses IndexedDB for browser-local identity, pairings, session history,
and offline-readable messages. Live connections use the existing Relay and
Pi Extension protocol.

Session attachments keep the original `File` in page memory until sending.
The PWA uploads originals over the existing Relay route and then submits their
IDs; only descriptions and bounded previews enter persisted history. Reloads
do not preserve unsent files, and the PWA has no original-file download action.
Limits, leases and host storage are documented in
[ARCHITECTURE](../docs/ARCHITECTURE.md#会话附件) and the
[session protocol](../docs/reference/protocol/protocol-v2.md#会话附件).

## Stack

- React 19 + Vite 8 and strict TypeScript
- Mantine components, Tailwind 4 and business CSS
- Serwist service worker, Dexie storage and system font stacks (no bundled or downloaded web fonts)
- ESLint, Vitest Node / Browser Mode and Playwright E2E
- pnpm workspace and the private shared package [`@pi-reach/protocol`](../packages/protocol/)

Versions and scripts are defined in [package.json](package.json) and the root
workspace configuration. Protocol ownership is documented in
[ARCHITECTURE](../docs/ARCHITECTURE.md#工程与构建边界).

## Commands

Install from the repository root with `pnpm install --frozen-lockfile`.
The root workspace owns the lockfile, catalogs and build approvals. Its
`prepare` script and `pnpm dev:pwa` build the shared protocol first; use
`pnpm dev:protocol` in another terminal while editing that package.

Run these commands from `pwa/`, or use `pnpm --filter pwa <command>` from the root:

```bash
pnpm dev       # Vite development server, default port 3000
pnpm build     # shared protocol, installer resource and dist/ production build
pnpm start     # local Vite preview of dist/, not a production server
pnpm typecheck
pnpm lint
pnpm test      # Node, Browser Mode, and production service worker tests
pnpm test:e2e  # builds and starts an isolated production preview
pnpm test:e2e:remote:list # lists the Docker-backed browser scenario without starting services
pnpm test:e2e:remote # Docker Relay/Extension with two real browser Owners
```

After changing shared protocol sources, build that package before PWA-only
checks, or use the corresponding root verification commands. The preview
script accepts `HOSTNAME` and `PORT`; Playwright uses `PLAYWRIGHT_E2E_PORT`.

## Layout

```text
index.html                       # metadata, root element and appearance boot script slot
vite.config.ts                   # build, routing plugin and Serwist integration
src/
├── main.tsx                     # React entry and existing providers / application shell
├── fonts.css                    # local fonts and existing font variables
├── app/                         # business styles and sw.ts service worker source
├── components/pwa/              # workspace UI
└── lib/
    ├── pwa/                     # browser runtime and IndexedDB persistence
    ├── pi-reach/                 # protocol adapters and transport
    └── ui/                      # Mantine theme and appearance key
scripts/
├── pwa-routing.mjs              # shared development / preview HTTP behavior
└── start-e2e-server.mjs          # local static preview
```

## Conventions

Application code runs in the browser. Reuse the existing Mantine providers,
components and business CSS; do not add a backend or API routes without
explicit authorization. Design constraints are maintained in
[DESIGN](../docs/DESIGN.md).

The service worker is generated at `dist/sw.js` and manually registered with
scope `/app`. Its precache maps the built HTML to the public `/app` URL and
includes local scripts, styles and fonts. Development does not generate a
service worker. Edit `src/app/sw.ts`, not the generated file.

## Deploy

Build the image from the repository root with
`docker build -f pwa/Dockerfile .`. The builder uses Node; the runtime uses
non-root Nginx to serve `dist/` at `/usr/share/nginx/html`. `PORT` defaults to
3000. HTML, the service worker and manifest use `no-cache`; successful hashed
assets use immutable caching.

Local preview and E2E use Vite preview, while production routing is maintained
in [nginx.conf.template](nginx.conf.template). Self-hosting with Compose and an
HTTPS reverse proxy is described in [Self-hosting](../README.en.md#self-hosting).
