<h1 align="center">Pi Reach</h1>

> A Pi Extension for controlling the current Pi process from the browser through a Relay.

`/pi-reach` connects the current Pi process to a Relay, supports Owner pairing, and exposes the live timeline plus typed session actions to the Pi Reach PWA.

## Endpoint model

```text
device -> endpoint -> runtime -> session / history generation
```

- **Device**: the computer's Ed25519 identity.
- **Endpoint and runtime**: generated randomly when a Pi process loads the Extension. They remain stable across Extension reloads in that process and are regenerated for the next Pi process.
- **Session / generation**: the active Pi conversation and its current history branch. Pi Reach does not list or resume historical sessions.

The endpoint never derives from the working directory. Pairing QR codes target the current endpoint and runtime, while the resulting Owner authorization is stored at device scope. Later Pi processes on that computer are discovered without pairing again.

## Quick start

Install the Extension once:

```bash
pi install npm:@yefengr/pi-reach
```

Open Pi in the project you want to control. When the session starts, the Extension automatically connects to the configured Relay. Pair the browser device from Pi:

```text
/pi-reach pair
```

Open the public [Pi Reach PWA](https://pi-reach.yefengr.cn/app) on your phone or another browser, scan the QR code or type the 8-character pairing code, then pick an online Pi and send a prompt. Each computer only needs to be paired once, and pairings are local to the computer that creates them:

```text
/pi-reach devices
/pi-reach revoke <shortid>
```

The public PWA and the default Relay are run by the maintainer. For sensitive work, self-host both; see [Self-hosting](../README.en.md#self-hosting) and [Pairing and security](#pairing-and-security).

## Commands

| Command | Description |
|---|---|
| `/pi-reach` | Connect the current Pi endpoint after it was stopped |
| `/pi-reach start` / `/pi-reach stop` | Connect or disconnect this endpoint |
| `/pi-reach status` | Show Relay, endpoint, runtime, and Owner state |
| `/pi-reach pair` | Show an endpoint-aware pairing QR |
| `/pi-reach devices` | List locally paired Owners |
| `/pi-reach revoke <shortid>` | Revoke one locally stored Owner |
| `/pi-reach set-relay <url>` | Persist the Relay URL |
| `/pi-reach config` | Show the resolved Relay URL |

The Extension handles remote `session_new` requests in-process through Pi's session API. There is no standalone `pi-reach` CLI, background process, scheduler, or service installation command.

## Relay configuration

The effective Relay URL resolves in this order:

1. `PI_REACH_RELAY`
2. `~/.pi/pi-reach/config.json`
3. `https://pi-reach-relay.yefengr.cn` (the public Relay run by the maintainer)

Set and inspect it from Pi:

```text
/pi-reach set-relay https://relay.example.com
/pi-reach config
```

Only `http://` and `https://` are accepted at the command boundary; WebSocket conversion happens inside the Extension. The Relay forwards opaque payloads and retains endpoint routing state in memory.

## Pairing and security

- There is no application-layer end-to-end encryption, so the Relay is fully trusted. Its operator can read every conversation and, because Owner identity comes only from the Relay-injected `source_owner_id`, could impersonate a paired browser and send prompts that Pi executes on your computer.
- Report vulnerabilities privately through GitHub's [private vulnerability reporting](https://github.com/yefengr/pi-reach/security/advisories/new); see the [security policy](https://github.com/yefengr/pi-reach/blob/main/SECURITY.md).
- `device_id` is the Host Ed25519 public key in canonical Base64 form.
- Owner messages are trusted only through the Relay-injected `source_owner_id`.
- Pairing and revocation update the Relay endpoint ACL with `authorized_owner_ids`.
- Relay loss enters reconnecting state; the Extension does not restart Pi to recover.
- Device private keys, pairing tokens, encrypted payloads, and message bodies are not logged.
- Concurrent Pi processes coordinate device identity initialization through a local lock. If initialization is interrupted, follow the [identity storage and lock recovery rules](../docs/reference/protocol/pairing.md#host); do not delete identity or pairing data to retry.

## Local state

Pi Reach stores global configuration, identity files, and pairings under `~/.pi/pi-reach`, and project display configuration under `.pi/pi-reach`. Its platform keyring service is `dev.pireach.pi`.

## Development

Install dependencies from the repository root with `pnpm install --frozen-lockfile`.
The root workspace owns dependency catalogs, build approvals, and the lockfile. The private workspace package [`@pi-reach/protocol`](../packages/protocol/) provides the shared protocol build artifacts; the Extension uses it as a development dependency, while installed users receive vendored artifacts and need neither the workspace nor a separately published shared package. Its module and distribution boundary is defined in [ARCHITECTURE](../docs/ARCHITECTURE.md#工程与构建边界).

The root `prepare` script and an Extension `pnpm build` build the shared package first. After changing shared sources, run `pnpm --filter @pi-reach/protocol build` from the repository root before an Extension-only `typecheck` or `test`, or use the corresponding root command.

Run these commands from `pi-extension/`, or use the `@yefengr/pi-reach` package filter:

```bash
pnpm typecheck
pnpm test
pnpm build
```

The development toolchain is pinned by the root configuration. The published
extension retains its Node 20+ runtime requirement. TypeScript ESM imports must
use `.js` extensions. `prepack` builds before packaging, and `pnpm pack` resolves
catalog and workspace references.

## License

MIT
