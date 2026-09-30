import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import test from "node:test";

import {
  createIdentity,
  defaultMetadata,
  hostHello,
  isRecord,
  ownerHello,
  routeFrame,
} from "./helpers.mjs";
import {
  RESOURCE_TIMEOUT_MS,
  assertPortClosed,
  authenticatePeer,
  disposeSocket,
  expectUpgradeStatus,
  openHost,
  openOwner,
  openPeer,
  openSocket,
  openTcpSocket,
  sendSocket,
  subscribe,
  waitForCondition,
  waitForSocketClose,
  waitForTcpClose,
  withLocalRelay,
  withPeers,
  withTimeout,
} from "./resources-helpers.mjs";

const RELAY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const MiB = 1024 * 1024;

function isFrame(value, type) {
  return isRecord(value) && value.type === type;
}

function matchesRoute(frame, options) {
  return isFrame(frame, "route")
    && frame.device_id === options.deviceId
    && frame.endpoint_id === options.endpointId
    && frame.runtime_instance_id === options.runtimeId
    && frame.purpose === options.purpose
    && frame.ct === options.ct;
}

async function assertHelloDeadline(helloTimeoutMs, authTimeoutMs) {
  await withLocalRelay({ limits: { helloTimeoutMs, authTimeoutMs } }, async ({ url: localUrl }) => {
    const peer = await openPeer(localUrl);
    try {
      const after = peer.cursor();
      await peer.waitForClose(after, RESOURCE_TIMEOUT_MS);
    } finally {
      await peer.dispose();
    }
  });
}

async function assertCapacityIsReleased(limits) {
  await withLocalRelay({ limits }, async ({ url }) => {
    const held = await openPeer(url);
    try {
      await expectUpgradeStatus(url, 503);
    } finally {
      await held.dispose();
    }

    const replacement = await openPeer(url);
    await replacement.dispose();
  });
}

function startCli() {
  const child = spawn(process.execPath, [CLI_ENTRY], {
    cwd: RELAY_ROOT,
    env: { ...process.env, PI_REACH_RELAY_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutBytes = 0;
  child.stdout.on("data", (chunk) => { stdoutBytes += chunk.length; });
  return { child, stdoutBytes: () => stdoutBytes };
}

async function waitForCliListening(child) {
  return withTimeout(new Promise((resolve, reject) => {
    let pending = "";
    const onData = (chunk) => {
      pending += chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.event === "relay_listening" && Number.isInteger(event.port) && event.port > 0) {
            cleanup();
            resolve(event.port);
            return;
          }
        } catch {
          // Startup errors are surfaced through child exit rather than raw stderr.
        }
        newline = pending.indexOf("\n");
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error("relay CLI exited before it reported a listening port"));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  }), RESOURCE_TIMEOUT_MS, "relay CLI listener");
}

function waitForChildExit(child) {
  return withTimeout(new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  }), RESOURCE_TIMEOUT_MS, "relay CLI exit");
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForChildExit(child).catch(() => undefined);
  child.kill("SIGKILL");
  await exited;
}

test("Node Relay resource and lifecycle contract", { concurrency: false, timeout: 60_000 }, async (t) => {
  await t.test("applies independent hello and auth deadlines", async (t) => {
    await t.test("closes a silent hello before the auth deadline", async () => {
      await assertHelloDeadline(45, 800);
    });

    await t.test("starts a distinct auth deadline after a valid hello", async () => {
      await withLocalRelay({ limits: { helloTimeoutMs: 800, authTimeoutMs: 45 } }, async ({ url }) => {
        const identity = createIdentity();
        const peer = await openPeer(url);
        try {
          const challengeAfter = peer.cursor();
          await peer.sendJson(ownerHello(identity));
          await peer.waitForJson((frame) => isFrame(frame, "challenge"), challengeAfter, RESOURCE_TIMEOUT_MS, "authentication challenge");
          const authAfter = peer.cursor();
          const startedAt = performance.now();
          await peer.waitForClose(authAfter, RESOURCE_TIMEOUT_MS);
          assert.ok(performance.now() - startedAt < 350, "auth timeout must not wait for the longer hello timeout");
        } finally {
          await peer.dispose();
        }
      });
    });
  });

  await t.test("returns HTTP 503 for pending and total connection exhaustion, then releases both budgets", async (t) => {
    await t.test("maxPendingAuth", async () => {
      await assertCapacityIsReleased({ maxConnections: 2, maxPendingAuth: 1, helloTimeoutMs: 500 });
    });
    await t.test("maxConnections", async () => {
      await assertCapacityIsReleased({ maxConnections: 1, maxPendingAuth: 1, helloTimeoutMs: 500 });
    });
  });

  await t.test("closes an oversized WebSocket payload with code 1009", async () => {
    await withLocalRelay({ limits: { maxFrameBytes: 256 } }, async ({ url }) => {
      const socket = await openSocket(url);
      try {
        const closed = waitForSocketClose(socket, RESOURCE_TIMEOUT_MS);
        await sendSocket(socket, Buffer.alloc(257));
        const { code } = await closed;
        assert.equal(code, 1009, "ws maxPayload must expose close code 1009 to the client");
      } finally {
        await disposeSocket(socket);
      }
    });
  });

  await t.test("rejects binary during the handshake and ignores binary after authentication", async () => {
    await withLocalRelay({}, async ({ url }) => {
      await withPeers(async (track) => {
        const handshake = track(await openPeer(url));
        const handshakeAfter = handshake.cursor();
        await sendSocket(handshake.socket, Buffer.from([1, 2, 3]));
        await handshake.waitForClose(handshakeAfter, RESOURCE_TIMEOUT_MS);

        const owner = await openOwner(url, track);
        const host = await openHost(url, track);
        const hostAfter = host.peer.cursor();
        await sendSocket(host.peer.socket, Buffer.from([4, 5, 6]));
        await owner.peer.sendJson(routeFrame({
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "pairing",
          ct: "binary-ready-barrier",
        }));
        await host.peer.waitForJson(
          (frame) => matchesRoute(frame, {
            deviceId: host.identity.id,
            endpointId: host.endpointId,
            runtimeId: host.runtimeId,
            purpose: "pairing",
            ct: "binary-ready-barrier",
          }),
          hostAfter,
          RESOURCE_TIMEOUT_MS,
          "post-binary route barrier",
        );
      });
    });
  });

  await t.test("terminates a peer that does not auto-pong and reclaims its slot", async () => {
    await withLocalRelay({
      limits: {
        maxConnections: 1,
        maxPendingAuth: 1,
        heartbeatIntervalMs: 75,
        helloTimeoutMs: 800,
        authTimeoutMs: 800,
      },
    }, async ({ url }) => {
      const identity = createIdentity();
      const peer = await authenticatePeer(url, identity, ownerHello(identity), { autoPong: false });
      try {
        let sawPing = false;
        peer.socket.once("ping", () => { sawPing = true; });
        await waitForCondition(() => sawPing, RESOURCE_TIMEOUT_MS, "server heartbeat ping");
        const after = peer.cursor();
        await peer.waitForClose(after, RESOURCE_TIMEOUT_MS);
      } finally {
        await peer.dispose();
      }

      await withPeers(async (track) => {
        const replacement = await openOwner(url, track);
        const snapshot = await subscribe(replacement, [replacement.identity.id]);
        assert.ok(isFrame(snapshot, "endpoints") && Array.isArray(snapshot.endpoints), "reclaimed capacity must authenticate a replacement owner");
      });
    });
  });

  await t.test("emits only structured event keys and never includes raw inbound content", async () => {
    const events = [];
    const helloMarker = `hello-${randomUUID()}`;
    const ctMarker = `ct-${randomUUID()}`;
    const signatureMarker = `signature-${randomUUID()}`;
    await withLocalRelay({ logger: (event) => events.push(event) }, async ({ url }) => {
      await withPeers(async (track) => {
        const host = await openHost(url, track, { metadata: defaultMetadata({ name: helloMarker }) });
        const routeAfter = events.length;
        await host.peer.sendJson(routeFrame({
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          targetOwnerId: createIdentity().id,
          ct: ctMarker,
        }));
        await waitForCondition(
          () => events.slice(routeAfter).some((event) => event.event === "route_dropped"),
          RESOURCE_TIMEOUT_MS,
          "dropped route log event",
        );

        const invalid = track(await openPeer(url));
        const challengeAfter = invalid.cursor();
        await invalid.sendJson(ownerHello(createIdentity()));
        await invalid.waitForJson((frame) => isFrame(frame, "challenge"), challengeAfter, RESOURCE_TIMEOUT_MS, "invalid-auth challenge");
        const rejectedAfter = events.length;
        const closeAfter = invalid.cursor();
        await invalid.sendJson({ type: "auth", sig: signatureMarker });
        await invalid.waitForClose(closeAfter, RESOURCE_TIMEOUT_MS);
        await waitForCondition(
          () => events.slice(rejectedAfter).some((event) => event.event === "connection_rejected"),
          RESOURCE_TIMEOUT_MS,
          "authentication rejection log event",
        );

        const allowedKeys = {
          connection_rejected: ["event", "outcome"],
          connection_closed: ["event", "role"],
          authenticated: ["event", "role"],
          frame_dropped: ["event", "outcome", "role"],
          route_dropped: ["event", "outcome", "role"],
          pairing_result: ["event", "outcome", "role"],
          transport_overflow: ["event", "role"],
        };
        for (const event of events) {
          assert.deepEqual(Object.keys(event).sort(), allowedKeys[event.event].slice().sort(), `unexpected logger fields for ${event.event}`);
        }
        const serialized = JSON.stringify(events);
        for (const rawValue of [helloMarker, ctMarker, signatureMarker, host.identity.id]) {
          assert.equal(serialized.includes(rawValue), false, "logger must not retain raw hello, route, signature, or identity input");
        }
      });
    });
  });

  await t.test("shuts down within a bounded deadline while a slow HTTP request is open", async () => {
    let relay;
    let socket;
    try {
      const { startRelay } = await import("../dist/server.js");
      relay = await startRelay({
        host: "127.0.0.1",
        port: 0,
        limits: { helloTimeoutMs: 1_000, shutdownTimeoutMs: 75 },
      });
      socket = await openTcpSocket(relay.port);
      socket.write("GET /health HTTP/1.1\r\nHost: relay\r\n");
      const closed = waitForTcpClose(socket, RESOURCE_TIMEOUT_MS);
      const startedAt = performance.now();
      await relay.close();
      const elapsedMs = performance.now() - startedAt;
      await closed;
      assert.ok(elapsedMs < 600, `shutdown exceeded bounded deadline: ${elapsedMs.toFixed(1)}ms`);
    } finally {
      socket?.destroy();
      await relay?.close().catch(() => undefined);
    }
  });

  await t.test("CLI exits cleanly on SIGTERM and SIGINT without leaving its listening port", async (t) => {
    for (const signal of ["SIGTERM", "SIGINT"]) {
      await t.test(signal, async () => {
        const { child, stdoutBytes } = startCli();
        let port;
        try {
          port = await waitForCliListening(child);
          const exited = waitForChildExit(child);
          assert.equal(child.kill(signal), true, `must deliver ${signal} to relay CLI`);
          const result = await exited;
          assert.equal(result.signal, null, `relay CLI must handle ${signal} rather than terminate by signal`);
          assert.equal(result.code, 0, `relay CLI must exit with code 0 after ${signal}`);
          assert.equal(stdoutBytes(), 0, "relay CLI must not write operational data to stdout");
          await assertPortClosed(port);
        } finally {
          await stopChild(child);
        }
      });
    }
  });

  await t.test("handles a fixed concurrent workload without unbounded resource growth", async (t) => {
    const connectionCount = 16;
    const messagesPerDirection = connectionCount;
    const startedAt = performance.now();
    const initialRss = process.memoryUsage().rss;
    let peakRss = initialRss;
    const monitor = monitorEventLoopDelay({ resolution: 20 });
    const rssSampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
    monitor.enable();
    try {
      await withLocalRelay({ limits: { maxConnections: 40, maxPendingAuth: 40 } }, async ({ url }) => {
        await withPeers(async (track) => {
          const identities = Array.from({ length: connectionCount }, () => createIdentity());
          const host = await openHost(url, track, { authorizedOwnerIds: identities.map((identity) => identity.id) });
          const owners = await Promise.all(identities.map(async (identity) => ({
            identity,
            peer: track(await authenticatePeer(url, identity, ownerHello(identity))),
          })));
          await Promise.all(owners.map((owner) => subscribe(owner, [host.identity.id])));

          const hostAfter = host.peer.cursor();
          await Promise.all(owners.map((owner, index) => owner.peer.sendJson(routeFrame({
            deviceId: host.identity.id,
            endpointId: host.endpointId,
            runtimeId: host.runtimeId,
            purpose: "session",
            ct: `concurrent-owner-to-host-${index}`,
          }))));
          await Promise.all(owners.map((owner, index) => host.peer.waitForJson(
            (frame) => matchesRoute(frame, {
              deviceId: host.identity.id,
              endpointId: host.endpointId,
              runtimeId: host.runtimeId,
              purpose: "session",
              ct: `concurrent-owner-to-host-${index}`,
            }) && frame.source_owner_id === owner.identity.id,
            hostAfter,
            RESOURCE_TIMEOUT_MS,
            "concurrent owner-to-host route",
          )));

          const ownerAfter = owners.map((owner) => owner.peer.cursor());
          await Promise.all(owners.map((owner, index) => host.peer.sendJson(routeFrame({
            deviceId: host.identity.id,
            endpointId: host.endpointId,
            runtimeId: host.runtimeId,
            purpose: "session",
            targetOwnerId: owner.identity.id,
            ct: `concurrent-host-to-owner-${index}`,
          }))));
          await Promise.all(owners.map((owner, index) => owner.peer.waitForJson(
            (frame) => matchesRoute(frame, {
              deviceId: host.identity.id,
              endpointId: host.endpointId,
              runtimeId: host.runtimeId,
              purpose: "session",
              ct: `concurrent-host-to-owner-${index}`,
            }) && frame.target_owner_id === owner.identity.id,
            ownerAfter[index],
            RESOURCE_TIMEOUT_MS,
            "concurrent host-to-owner route",
          )));
        });
      });
    } finally {
      clearInterval(rssSampler);
      monitor.disable();
    }
    const elapsedMs = performance.now() - startedAt;
    const rssDelta = peakRss - initialRss;
    const eventLoopP99Ms = monitor.percentile(99) / 1e6;
    assert.ok(elapsedMs < 12_000, `concurrent workload took too long: ${elapsedMs.toFixed(1)}ms`);
    assert.ok(rssDelta < 256 * MiB, `concurrent workload retained too much RSS: ${(rssDelta / MiB).toFixed(1)}MiB`);
    assert.ok(eventLoopP99Ms < 1_500, `event-loop delay was unexpectedly high: ${eventLoopP99Ms.toFixed(1)}ms`);
    t.diagnostic(`concurrency connections=${connectionCount} messages=${messagesPerDirection * 2} duration_ms=${elapsedMs.toFixed(1)} rss_delta_mib=${(rssDelta / MiB).toFixed(1)} event_loop_p99_ms=${eventLoopP99Ms.toFixed(1)}`);
  });

  await t.test("disconnects a paused slow owner while a healthy owner continues bidirectional routing", async (t) => {
    const frameCount = 64;
    const payloadBytes = 64 * 1024;
    const ownerIdentity = createIdentity();
    const initialRss = process.memoryUsage().rss;
    let peakRss = initialRss;
    const monitor = monitorEventLoopDelay({ resolution: 20 });
    const rssSampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
    const startedAt = performance.now();
    monitor.enable();
    try {
      await withLocalRelay({
        limits: {
          maxFrameBytes: 128 * 1024,
          maxBufferedBytes: 128 * 1024,
          maxTotalBufferedBytes: 512 * 1024,
          heartbeatIntervalMs: 10_000,
          shutdownTimeoutMs: 200,
        },
      }, async ({ url }) => {
        await withPeers(async (track) => {
          const host = await openHost(url, track, { authorizedOwnerIds: [ownerIdentity.id] });
          const slow = await openOwner(url, track, ownerIdentity);
          const healthy = await openOwner(url, track, ownerIdentity);
          await Promise.all([
            subscribe(slow, [host.identity.id]),
            subscribe(healthy, [host.identity.id]),
          ]);

          const slowStream = slow.peer.socket._socket;
          assert.ok(slowStream !== undefined && typeof slowStream.pause === "function" && typeof slowStream.resume === "function", "test requires a pausable real TCP WebSocket stream");
          slowStream.pause();
          try {
            for (let index = 0; index < frameCount; index += 1) {
              const healthyAfter = healthy.peer.cursor();
              const ct = `${index}:`.padEnd(payloadBytes, "x");
              await host.peer.sendJson(routeFrame({
                deviceId: host.identity.id,
                endpointId: host.endpointId,
                runtimeId: host.runtimeId,
                purpose: "session",
                targetOwnerId: ownerIdentity.id,
                ct,
              }));
              // 接收回执证明此连接持续消费；不能用发送方 write callback 冒充接收方进度。
              await healthy.peer.waitForJson(
                (frame) => matchesRoute(frame, {
                  deviceId: host.identity.id,
                  endpointId: host.endpointId,
                  runtimeId: host.runtimeId,
                  purpose: "session",
                  ct,
                }),
                healthyAfter,
                2_000,
                "healthy owner slow-consumer route",
              );
            }

            const slowAfter = slow.peer.cursor();
            slowStream.resume();
            await slow.peer.waitForClose(slowAfter, 10_000);

            const hostAfter = host.peer.cursor();
            await healthy.peer.sendJson(routeFrame({
              deviceId: host.identity.id,
              endpointId: host.endpointId,
              runtimeId: host.runtimeId,
              purpose: "session",
              ct: "healthy-owner-post-slow-barrier",
            }));
            await host.peer.waitForJson(
              (frame) => matchesRoute(frame, {
                deviceId: host.identity.id,
                endpointId: host.endpointId,
                runtimeId: host.runtimeId,
                purpose: "session",
                ct: "healthy-owner-post-slow-barrier",
              }) && frame.source_owner_id === ownerIdentity.id,
              hostAfter,
              RESOURCE_TIMEOUT_MS,
              "healthy owner reverse route after slow disconnect",
            );
          } finally {
            slowStream.resume();
          }
        });
      });
    } finally {
      clearInterval(rssSampler);
      monitor.disable();
    }
    const elapsedMs = performance.now() - startedAt;
    const rssDelta = peakRss - initialRss;
    const eventLoopP99Ms = monitor.percentile(99) / 1e6;
    assert.ok(elapsedMs < 15_000, `slow-consumer exercise took too long: ${elapsedMs.toFixed(1)}ms`);
    assert.ok(rssDelta < 256 * MiB, `slow-consumer exercise retained too much RSS: ${(rssDelta / MiB).toFixed(1)}MiB`);
    assert.ok(eventLoopP99Ms < 1_500, `slow-consumer event-loop delay was unexpectedly high: ${eventLoopP99Ms.toFixed(1)}ms`);
    t.diagnostic(`slow_consumer frames=${frameCount} payload_mib=${((frameCount * payloadBytes) / MiB).toFixed(1)} duration_ms=${elapsedMs.toFixed(1)} rss_delta_mib=${(rssDelta / MiB).toFixed(1)} event_loop_p99_ms=${eventLoopP99Ms.toFixed(1)}`);
  });
});
