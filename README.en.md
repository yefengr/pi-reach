<p align="center">
  <img src="pwa/public/logo.svg" width="140" alt="Pi Reach logo" />
</p>

<h1 align="center">Pi Reach</h1>

<p align="center">Control the <a href="https://github.com/earendil-works/pi">Pi coding agent</a> running on your computer from your phone or any browser.</p>

<p align="center"><a href="README.md">简体中文</a> · <b>English</b></p>

Pi Reach gives Pi a browser front end. Away from your desk, pair your phone by scanning a QR code, then follow Pi's live output, send new instructions, stop a task, or switch models. The session always runs on your own computer.

> [!NOTE]
> Pi Reach is at an early stage. The protocol and local data formats may still change.

## Features

- **QR pairing, no account**: generate a QR code in Pi, then scan it with your phone or type the 8-character pairing code.
- **Multiple computers, multiple Pis**: one browser can pair with several computers, and every Pi open on a computer is listed so you can switch between them.
- **Live sessions**: stream replies and tool calls, send text and images (photo library, camera, or clipboard), and stop the current task at any time.
- **Session controls**: start a new session, compact the context, and switch the model or thinking level.
- **Local history**: received conversations are saved in the browser and stay readable offline.
- **Installable PWA**: add it to your home screen; light and dark themes, Chinese and English UI.

## How it works

```text
Phone / browser (PWA)  ⇄  Relay  ⇄  Pi + Pi Reach Extension on your computer
```

- The **Extension** connects to the Relay when Pi starts and goes offline when Pi exits. Pi Reach never starts or wakes Pi remotely.
- The **Relay** only tracks online status, enforces access control, and forwards messages. All of its state lives in memory, and it stores no conversation content.
- The **PWA** is a static web app. Pairings and conversation history stay in the current browser, while the computer keeps its identity and pairings locally (`~/.pi/pi-reach` and the system keychain). There are no cloud accounts and no cloud sync.

## Quick start

Install the [Pi coding agent](https://github.com/earendil-works/pi) first, then:

1. Install the Extension:

   ```bash
   pi install npm:@yefengr/pi-reach
   ```

   By default it applies to all your projects; add `-l` to install it for the current project only.

2. Start Pi as usual. The Extension connects to the Relay automatically, by default the public Relay run by the maintainer of this project (see [Security model](#security-model)).
3. On your phone or another device, open <https://pi-reach.yefengr.cn/app> in a browser. You can add it to your home screen.
4. Run the following command in Pi, then scan the QR code shown in the terminal with the PWA, or type the 8-character pairing code:

   ```text
   /pi-reach pair
   ```

5. Pick an online Pi in the PWA and send your first message.

Each computer only needs to be paired once. After that, every Pi on that computer with the Extension loaded appears in the PWA automatically.

## Commands

| Command | What it does |
| --- | --- |
| `/pi-reach pair` | Show a pairing QR code and pairing code |
| `/pi-reach status` | Show connection and pairing status |
| `/pi-reach devices` | List the browsers paired with this computer |
| `/pi-reach revoke <shortid>` | Revoke a paired browser (`shortid` is shown by `devices`) |
| `/pi-reach stop`, `/pi-reach start` | Disconnect from or reconnect to the Relay |
| `/pi-reach set-relay <url>` | Set the Relay URL |
| `/pi-reach config` | Show the Relay URL in use |

## Configuring the Relay

Pi and the PWA must use the same Relay; the QR code does not carry the Relay URL.

- **Pi** checks the `PI_REACH_RELAY` environment variable first, then the URL saved with `/pi-reach set-relay` (`~/.pi/pi-reach/config.json`), and falls back to the public default Relay.
- **PWA**: change it under **Settings → Connection → Relay URL**.

Use an `https://` Relay URL (`http://` is fine for local testing); both clients derive the WebSocket URL automatically.

## Self-hosting

The public Relay and PWA are run by the maintainer and are fine for trying Pi Reach out. For sensitive code, run your own. Both build as Docker images from the repository root and are orchestrated by the root `docker-compose.yml`:

```bash
docker build -f relay/Dockerfile -t pi-reach-relay .
docker build -f pwa/Dockerfile -t pi-reach-pwa .
RELAY_IMAGE=pi-reach-relay SITE_IMAGE=pi-reach-pwa docker compose up -d
```

Compose listens on loopback only (the Relay on `127.0.0.1:3000`, the PWA on `127.0.0.1:3001`), so put an HTTPS reverse proxy in front, for example Caddy:

```caddyfile
pwa.example.com {
    reverse_proxy 127.0.0.1:3001
}

relay.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Then run `/pi-reach set-relay https://relay.example.com` in Pi, open `https://pwa.example.com/app`, enter the same Relay URL in Settings, and run `/pi-reach pair` again.

Serve the PWA over HTTPS (or `localhost` on the same device); otherwise browsers may disable the crypto and camera APIs it relies on. See the [Relay README](relay/README.md) for resource limits and [DEPLOYMENT](docs/DEPLOYMENT.md) (Chinese) for server preparation and the release flow.

## Security model

> [!WARNING]
> Pi Reach has no application-layer end-to-end encryption. The Relay is a fully trusted party.

- Traffic is protected by TLS only, and message content is not encrypted from the Relay. Whoever runs the Relay can read every conversation, including code, commands, and output.
- The Relay also authenticates browser identities, so its operator could impersonate a paired browser and send instructions to your Pi, which can run commands on your computer.
- The public default Relay (`pi-reach-relay.yefengr.cn`) is run by the maintainer of this project. For sensitive code, use a [self-hosted](#self-hosting) Relay.
- Pairings are per computer. Revoke browsers you no longer use with `/pi-reach revoke` on that computer.
- Browser identity and history are stored only locally. Clearing site data deletes both, and you will need to pair again.

The full trust boundary is described in the [protocol and security reference](docs/reference/protocol/README.md) (Chinese). When reporting a security issue, do not include keys, pairing codes, or exploit details in a public issue.

## Non-goals

Pi Reach focuses on remotely controlling the Pi you currently have open. It does not provide:

- starting, waking, or running Pi in the background (once Pi exits, it can no longer be controlled remotely);
- cloud accounts, multi-device sync, or cloud backups of conversations;
- browsing or resuming Pi's past sessions (only history saved in the browser can be viewed);
- a persistent connection or push notifications while the phone is locked;
- an offline send queue (sending a message requires a live connection);
- application-layer end-to-end encryption.

## Development

| Directory | Stack | Responsibility |
| --- | --- | --- |
| [`pi-extension/`](pi-extension/) | Node.js + TypeScript | Pi Extension: device identity, pairing, and the session protocol |
| [`relay/`](relay/) | Node.js + TypeScript + ws | WebSocket Relay: authentication, online registry, access control, and forwarding |
| [`pwa/`](pwa/) | Vite + React + TypeScript | Browser PWA |
| [`packages/protocol/`](packages/protocol/) | TypeScript + Zod | Private package with the protocol types and codecs shared by all three |

Node and pnpm versions are pinned by [`.node-version`](.node-version) and the `packageManager` field of the root [`package.json`](package.json). Install from the repository root and start the PWA:

```bash
pnpm install --frozen-lockfile
pnpm dev:pwa
```

| Command | What it does |
| --- | --- |
| `pnpm dev:pwa` | Build the shared package and start the PWA dev server |
| `pnpm dev:protocol` | Rebuild the shared package continuously while you change it |
| `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` | Type-check, lint, test, and build |
| `pnpm verify` | Run the four commands above in sequence, including the Relay, deploy-script simulation, and production Service Worker checks; excludes Playwright and Docker E2E |
| `pnpm test:e2e` | Run the PWA production-preview, Docker protocol, and real-browser end-to-end tests in sequence |
| `pnpm verify:release` | Run `verify`, then all E2E tests |
| `pnpm test:relay` | Build and verify the Relay on its own |

To work on a single package, use `pnpm --filter <package> <command>` with `pwa`, `@yefengr/pi-reach`, `@pi-reach/relay`, or `@pi-reach/protocol`. A package's `pnpm build` builds the shared package first. After changing the shared package, run `pnpm --filter @pi-reach/protocol build` before a package-only `typecheck` or `test`, or use the root commands instead. Collaboration and verification rules are in [AGENTS.md](AGENTS.md) (Chinese).

## Documentation

Detailed documentation is currently written in Chinese.

| Document | Contents |
| --- | --- |
| [Context](docs/CONTEXT.md) | Use cases, core concepts, data and trust boundaries |
| [Architecture](docs/ARCHITECTURE.md) | Responsibilities, state ownership, and build boundaries |
| [Protocol & security](docs/reference/protocol/README.md) | Identity, pairing, messages, and the trust model |
| [Design](docs/DESIGN.md) | PWA UI and interaction rules |
| [Deployment](docs/DEPLOYMENT.md) | Server preparation, Caddy setup, and the release flow |
| [Roadmap](docs/ROADMAP.md) · [Backlog](docs/BACKLOG.md) | Committed work and candidate ideas |

## License

[MIT](LICENSE)
