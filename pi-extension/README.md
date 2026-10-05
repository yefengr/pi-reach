# Pi Reach

Control your running Pi coding agent from your phone or any browser.

When you step away from your computer, Pi Reach lets you follow Pi's live responses and tool calls, send another prompt or a file, and stop the current task. Pi keeps running on your computer; the browser is its remote interface.

![Pi Reach desktop workspace with multiple online Pi sessions and a live conversation](https://raw.githubusercontent.com/yefengr/pi-reach/main/docs/assets/screenshot-desktop-en.png)

## Features

- **Pair without an account**: scan a QR code or enter an 8-character pairing code. Pair each computer once; later Pi processes on that computer appear automatically.
- **Switch between computers and Pi sessions**: connect to multiple computers and choose among the Pi processes currently running on each one.
- **Follow and control a live conversation**: stream responses and tool calls, send prompts and file attachments, or stop the current task. Attachments reach your computer as original files for Pi to read; image previews do not automatically become model vision input.
- **Manage the current session**: start a new conversation, compact context, or change the model and thinking level.
- **Use an installable PWA**: add the browser app to your home screen, choose light or dark mode, and use English or Chinese. Previously received conversations remain available for read-only viewing in that browser while offline.

![Pi Reach mobile conversation with tool activity and the message composer](https://raw.githubusercontent.com/yefengr/pi-reach/main/docs/assets/screenshot-mobile-en.png)

## Quick start

1. Install the Extension:

   ```bash
   pi install npm:@yefengr/pi-reach
   ```

2. Open Pi in the project you want to control. The Extension automatically connects to the configured Relay when the session starts.
3. Open the public [Pi Reach PWA](https://pi-reach.yefengr.cn/app) on your phone or another browser.
4. Run this command in Pi, then scan the terminal QR code from the PWA or enter the 8-character pairing code:

   ```text
   /pi-reach pair
   ```

5. Pick an online Pi in the PWA and send your first prompt.

Each computer only needs to be paired once. Pairings apply to the computer that creates them, not to every computer you use.

The public PWA and the default Relay are run by the maintainer. For sensitive work, [self-host the PWA and Relay](https://github.com/yefengr/pi-reach/blob/main/README.en.md#self-hosting).

## Security and limits

**Pi Reach has no application-layer end-to-end encryption. The Relay is fully trusted.** TLS protects transport, but the Relay operator can read conversation content, including code, commands, and output. The operator could also impersonate a paired browser and send prompts that Pi executes on your computer. Use a Relay you control for sensitive work.

- Pi must already be running with the Extension loaded. Pi Reach cannot remotely start, wake, or keep Pi running in the background.
- Browser history is a local, read-only cache of received conversations, not a cloud backup or a way to browse and resume old Pi sessions on your computer.
- Sending prompts and files requires a live connection. There is no offline send queue or push notifications, and phone lock-screen connectivity is not guaranteed.
- Browser identity, pairings, and received history stay in that browser's local storage. Clearing site data removes them and requires pairing again. There are no cloud accounts or cross-browser history synchronization.
- Revoke browsers you no longer use from Pi with `/pi-reach revoke <shortid>`; list them with `/pi-reach devices`.

Report vulnerabilities through GitHub's [private vulnerability reporting](https://github.com/yefengr/pi-reach/security/advisories/new); see the [security policy](https://github.com/yefengr/pi-reach/blob/main/SECURITY.md).

## Commands

| Command | Description |
|---|---|
| `/pi-reach` | Reconnect this Pi after `/pi-reach stop` |
| `/pi-reach start` / `/pi-reach stop` | Connect or disconnect this Pi |
| `/pi-reach status` | Show Relay, endpoint, runtime, and paired-browser state |
| `/pi-reach pair` | Show a pairing QR code and pairing code for this Pi |
| `/pi-reach devices` | List browsers paired with this computer |
| `/pi-reach revoke <shortid>` | Revoke a browser's pairing on this computer |
| `/pi-reach set-relay <url>` | Save the Relay URL |
| `/pi-reach config` | Show the resolved Relay URL |

## Relay configuration

Pi and the PWA must use the same Relay. The pairing QR code does not carry a Relay address.

The Extension resolves its Relay URL in this order:

1. `PI_REACH_RELAY`
2. `~/.pi/pi-reach/config.json`
3. `https://pi-reach-relay.yefengr.cn` (the public Relay run by the maintainer)

Set and inspect it from Pi:

```text
/pi-reach set-relay https://relay.example.com
/pi-reach config
```

In the PWA, set the same URL under **Settings → Connection → Relay URL**. Use `https://` for a deployed Relay; `http://` is accepted for local development. The Extension converts the URL to WebSocket form internally. The Relay retains routing state in memory and does not persist conversations.

## Endpoint model and local state

```text
device -> endpoint -> runtime -> session / history generation
```

- **Device**: the computer's Ed25519 identity and the scope of pairing authorization.
- **Endpoint and runtime**: generated randomly when a Pi process loads the Extension. They remain stable across Extension reloads in that process and are regenerated for the next Pi process. The endpoint is not derived from the working directory.
- **Session / generation**: the active Pi conversation and its current history branch. Pi Reach does not list or resume historical Pi sessions.

Pairing QR codes target the current endpoint and runtime; the resulting browser authorization is stored at device scope. Owner messages are trusted only through the Relay-injected `source_owner_id`. Pairing and revocation update the Relay endpoint ACL with `authorized_owner_ids`.

The Extension handles remote `session_new` requests in-process through Pi's session API. There is no standalone `pi-reach` CLI, background process, scheduler, or service installation command. Relay loss triggers reconnection, not a Pi restart.

Pi Reach stores global configuration, identity files, and pairings under `~/.pi/pi-reach`, and project display configuration under `.pi/pi-reach`. Its platform keyring service is `dev.pireach.pi`. Device private keys, pairing tokens, and message bodies are not logged.

Concurrent Pi processes coordinate device identity initialization through a local lock. If initialization is interrupted, follow the [identity storage and lock recovery rules](https://github.com/yefengr/pi-reach/blob/main/docs/reference/protocol/pairing.md#host); do not delete identity or pairing data to retry.

## Development

Install dependencies from the repository root with `pnpm install --frozen-lockfile`.
The root workspace owns dependency catalogs, build approvals, and the lockfile. The private workspace package [`@pi-reach/protocol`](https://github.com/yefengr/pi-reach/tree/main/packages/protocol) provides the shared protocol build artifacts; the Extension uses it as a development dependency, while installed users receive vendored artifacts and need neither the workspace nor a separately published shared package. Its module and distribution boundary is defined in [ARCHITECTURE](https://github.com/yefengr/pi-reach/blob/main/docs/ARCHITECTURE.md#工程与构建边界).

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
