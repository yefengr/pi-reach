# Pi Reach — Relay

A TypeScript service running on Node.js and `ws`. It authenticates connections from the browser PWA and Pi Extension, announces endpoints to authorized Owners, and forwards opaque `ct` payloads. See the [root README](../README.md) for the product overview and [protocol reference](../docs/reference/protocol/README.md) for the wire contract.

## Routing and state

The Relay keeps its registry, subscriptions, endpoint ACLs, and short-lived pairing offers in memory. A Relay restart clears that state; connected clients authenticate and announce or discover endpoints again. The Relay does not write a database, message store, pairing history, or endpoint inventory.

A `(device_id, endpoint_id)` has one authoritative connection and runtime. A replacement makes older connections stale, including their later cleanup callbacks. Owners only discover endpoints whose current ACL authorizes them. Session routes require that ACL; pairing routes only bypass the session ACL and remain bound to the named endpoint/runtime. Pairing authorization itself belongs to the Extension. Multiple connections for the same Owner may coexist and receive Host replies.

`ct` is never decoded, inspected, logged, or persisted by this service. Connections use Ed25519 challenge-response authentication and should use TLS in production. Opaque forwarding is an implementation boundary, not protection from an operator who controls the Relay executable or TLS endpoint. Use infrastructure you trust for sensitive work.

## Local development

Use the Node and pnpm versions declared at the repository root. From that root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @pi-reach/relay build
pnpm --filter @pi-reach/relay start
```

The CLI listens on `0.0.0.0:3000`. `PI_REACH_RELAY_PORT` overrides the port; invalid configuration fails startup. Port `0` requests an ephemeral port for isolated tests. The listening port is emitted as a structured startup event.

The WebSocket upgrade endpoint is `/`. `GET /health` and `HEAD /health` return `200`; the GET body is `OK`. Health is liveness only. There is no business HTTP API or persistent state to mount.

## Resource limits

Defaults and environment names are defined in [`src/config.ts`](src/config.ts). Every limit must be a positive safe integer; timer values must fit Node's timer range. Pending authentication cannot exceed the total connection limit, and the per-connection send budget cannot exceed the global send budget.

| Environment variable | Default | What it bounds |
| --- | --- | --- |
| `PI_REACH_RELAY_MAX_FRAME_BYTES` | 4 MiB | Incoming WebSocket message size, including fragmented messages |
| `PI_REACH_RELAY_MAX_BUFFERED_BYTES` | 8 MiB | Outstanding writes per connection |
| `PI_REACH_RELAY_MAX_DISCOVERY_BYTES` | 4 MiB, implicitly clamped to the per-connection buffer limit | Conservative aggregate budget for complete endpoint discovery snapshots and endpoint visibility events |
| `PI_REACH_RELAY_MAX_TOTAL_BUFFERED_BYTES` | 64 MiB | Outstanding writes across all connections |
| `PI_REACH_RELAY_MAX_CONNECTIONS` | 256 | WebSocket connections, including authentication and closing sockets |
| `PI_REACH_RELAY_MAX_PENDING_AUTH` | 32 | Connections waiting for hello or authentication |
| `PI_REACH_RELAY_MAX_SUBSCRIPTIONS` | 1024 | Declared device IDs per Owner subscription |
| `PI_REACH_RELAY_MAX_AUTHORIZED_OWNERS` | 1024 | Declared Owner IDs per Host ACL |
| `PI_REACH_RELAY_MAX_METADATA_BYTES` | 64 KiB | Endpoint metadata |
| `PI_REACH_RELAY_HELLO_TIMEOUT_MS` | 5000 | Time to receive hello |
| `PI_REACH_RELAY_AUTH_TIMEOUT_MS` | 5000 | Time to authenticate after challenge |
| `PI_REACH_RELAY_HEARTBEAT_INTERVAL_MS` | 25000 | Ping interval; a missing pong causes termination at the next tick |
| `PI_REACH_RELAY_SHUTDOWN_TIMEOUT_MS` | 5000 | Close/force-termination deadline |

Raw HTTP sockets also have a limit of `maxConnections + maxPendingAuth` and a hello-sized header deadline. Excess WebSocket upgrades receive HTTP 503. Oversized messages close with WebSocket code 1009; policy violations close with 1008. A connection exceeding its send budget is terminated. When the global send budget is exhausted, the Relay removes an existing connection with the largest backlog before admitting another write. It does not queue or silently discard selected application messages for later delivery.

SIGINT and SIGTERM stop admission and close sockets within the configured deadline. Structured diagnostic events contain no message bodies, signatures, invitation codes, or full identity keys. When stderr is backpressured, subsequent diagnostic events are dropped until it drains so logging cannot create another unbounded queue.

## Docker and TLS

Build from the repository root:

```bash
docker build -f relay/Dockerfile -t pi-reach-relay:local .
docker run -d --name pi-reach-relay \
  -p 127.0.0.1:3000:3000 \
  --restart unless-stopped pi-reach-relay:local
```

The image runs as a non-root Node user and contains compiled code and production dependencies. Its build creates a self-contained deployment of the private protocol package; it does not require the workspace at runtime. Docker health checks use `/health`.

A TLS-terminating Caddy proxy can expose it:

```text
relay.example.com {
    reverse_proxy localhost:3000
}
```

Use `https://relay.example.com` in the PWA and `/pi-reach set-relay https://relay.example.com` in Pi. Both clients convert HTTP(S) Relay URLs to the corresponding WebSocket scheme. The shared Relay is `https://pi-reach-relay.yefengr.cn`; a local source change does not deploy or change that service. Publication and remote deployment require separate authorization; see [DEPLOYMENT](../docs/DEPLOYMENT.md).

## Verification

From the repository root:

```bash
pnpm --filter @pi-reach/protocol build
pnpm --filter @pi-reach/relay typecheck
pnpm test:relay
```

The package test command builds current output, runs Vitest, then runs the real WebSocket suites. Black-box and numeric tests normally start an isolated server; to compare another test implementation:

```bash
RELAY_TEST_URL=ws://127.0.0.1:3000 node --test \
  relay/test/blackbox.test.mjs relay/test/numeric.test.mjs
```

Use a dedicated test Relay, never a production service. Resource tests create isolated Node instances and include pending-auth capacity, frame limits, heartbeat expiry, log privacy, bounded shutdown, CLI signals, concurrent clients, and a paused TCP receiver. Recorded load results describe those conditions only; they are not a production capacity rating. Real Extension/PWA acceptance uses the [fixed E2E topology](../docker/e2e/README.md).
