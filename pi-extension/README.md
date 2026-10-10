# Pi Reach

Control your running Pi coding agent from your phone or any browser.

When you're away from your desk, Pi Reach lets you watch Pi's replies and tool calls as they arrive, send a follow-up prompt or a file, and stop the current task. Pi still runs on your computer as usual. The browser shows what it's doing and passes your input to it.

![Pi Reach on desktop with multiple online Pi sessions and a live conversation, next to the same conversation on a phone in dark mode](https://raw.githubusercontent.com/yefengr/pi-reach/main/docs/assets/screenshot-hero-en.png)

## Quick start

1. Install the Extension:

   ```bash
   pi install npm:@yefengr/pi-reach
   ```

2. Start Pi in the project you want to control. The Extension connects to the configured Relay as soon as the session starts.
3. On your phone or another browser, open the public [Pi Reach PWA](https://pi-reach.yefengr.cn/app).
4. Run this command in Pi:

   ```text
   /pi-reach pair
   ```

   Then scan the QR code in the terminal from the PWA, or type the 8-character pairing code.

5. In the PWA, choose a Pi that shows as online and send your first prompt.

You pair each computer once. After that, every Pi you start on that computer shows up in the PWA automatically. Other computers need their own pairing.

The public PWA and the default Relay are run by the maintainer. For sensitive work, [self-host the PWA and Relay](https://github.com/yefengr/pi-reach/blob/main/README.en.md#self-hosting).

## What you can do

- Pair a browser by scanning a QR code or entering an 8-character code. No account is needed.
- Connect to several computers and choose among the Pi processes currently running on each one.
- Watch replies and tool calls stream in, send prompts and attachments, or stop the current task. Attachments arrive on your computer as the original files for Pi to read. Attached images are not automatically passed to the model as vision input.
- Start a new conversation, compact context, or change the model and thinking level.
- Add the PWA to your home screen, and switch between light and dark mode or between English and Chinese.
- Reopen conversations this browser has already received, even offline. They are read-only.

## Security and limits

**Pi Reach has no application-layer end-to-end encryption, so you have to fully trust whoever runs the Relay.** TLS protects the connection, but the Relay operator can read your conversations, including code, commands, and output. They could also pose as one of your paired browsers and send prompts that Pi runs on your computer. For sensitive work, use a Relay you control.

- Pi must already be running with the Extension loaded. Pi Reach can't start Pi remotely, wake it up, or keep it running in the background.
- The history in your browser is a local, read-only copy of conversations it has received. It isn't a cloud backup, and you can't use it to browse or resume older Pi sessions on your computer.
- Sending prompts and files needs a live connection. Nothing is queued while you're offline, there are no push notifications, and the connection isn't guaranteed to stay up while your phone is locked.
- Each browser keeps its identity, pairings, and received history in local storage. Clearing site data deletes them, and you'll need to pair again. There are no cloud accounts, and history doesn't sync between browsers.
- To remove a browser you no longer use, list paired browsers with `/pi-reach devices` in Pi, then revoke it with `/pi-reach revoke <shortid>`.

Report vulnerabilities through GitHub's [private vulnerability reporting](https://github.com/yefengr/pi-reach/security/advisories/new); see the [security policy](https://github.com/yefengr/pi-reach/blob/main/SECURITY.md).

## Commands

| Command | Description |
|---|---|
| `/pi-reach` or `/pi-reach start` | Connect this Pi (for example, after `/pi-reach stop`) |
| `/pi-reach stop` | Disconnect this Pi |
| `/pi-reach status` | Show the Relay connection, endpoint, runtime, and number of connected browsers |
| `/pi-reach pair` | Show a pairing QR code and pairing code for this Pi |
| `/pi-reach devices` | List browsers paired with this computer |
| `/pi-reach revoke <shortid>` | Revoke a browser's pairing on this computer |
| `/pi-reach set-relay <url>` | Save the Relay URL |
| `/pi-reach config` | Show the Relay URL currently in use |

## Relay configuration

Pi and the PWA must use the same Relay. The pairing QR code doesn't include the Relay address, so set it on both sides.

The Extension picks its Relay URL from the first of these that is set:

1. `PI_REACH_RELAY`
2. `~/.pi/pi-reach/config.json`
3. `https://pi-reach-relay.yefengr.cn` (the public Relay run by the maintainer)

Set and check it from Pi:

```text
/pi-reach set-relay https://relay.example.com
/pi-reach config
```

In the PWA, enter the same URL under **Settings → Connection → Relay URL**. Use `https://` for a deployed Relay; `http://` is accepted for local development. Don't enter a `ws://` or `wss://` address: the Extension converts the URL to WebSocket form itself. The Relay keeps routing state in memory and does not store conversations.

## Local data

- Global configuration, identity files, and pairings are stored in `~/.pi/pi-reach`, and per-project display settings in `.pi/pi-reach`. The system keyring entry uses the service name `dev.pireach.pi`.
- Device private keys, pairing tokens, and message bodies are not written to logs.
- Pi processes running at the same time coordinate device identity setup through a local lock. If that setup is interrupted, follow the [identity storage and lock recovery rules](https://github.com/yefengr/pi-reach/blob/main/docs/reference/protocol/pairing.md#host). Don't delete identity or pairing data to retry.

## More documentation

- [Development setup](https://github.com/yefengr/pi-reach/blob/main/README.en.md#development) and [contributing guide](https://github.com/yefengr/pi-reach/blob/main/CONTRIBUTING.md)
- [Architecture](https://github.com/yefengr/pi-reach/blob/main/docs/ARCHITECTURE.md), including the device, endpoint, and runtime model (in Chinese)
- [Protocol and security](https://github.com/yefengr/pi-reach/blob/main/docs/reference/protocol/README.md) (in Chinese)

## License

MIT
