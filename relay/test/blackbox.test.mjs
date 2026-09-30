import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  ABSENCE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  authenticate,
  beginAuthentication,
  connectPeer,
  createIdentity,
  defaultMetadata,
  disposePeers,
  endpointUpdateFrame,
  hostHello,
  isRecord,
  nonCanonicalId,
  ownerHello,
  pairingOfferFrame,
  randomPairingCode,
  resolvePairingCodeFrame,
  routeFrame,
  signNonce,
  subscriptionFrame,
} from "./helpers.mjs";

const OPAQUE_OWNER_TO_HOST = "opaque route payload: not base64";
const OPAQUE_HOST_TO_OWNER = "opaque response payload: not JSON";
const OFFER_TTL_MS = 30_000;

async function withScenario(url, callback) {
  const peers = [];
  const track = (peer) => {
    peers.push(peer);
    return peer;
  };
  try {
    return await callback(track);
  } finally {
    await disposePeers(peers);
  }
}

async function openOwner(url, track, identity = createIdentity()) {
  return { identity, peer: track(await authenticate(url, identity, ownerHello(identity))) };
}

async function openHost(url, track, options = {}) {
  const identity = options.identity ?? createIdentity();
  const endpointId = options.endpointId ?? randomUUID();
  const runtimeId = options.runtimeId ?? randomUUID();
  const peer = track(await authenticate(
    url,
    identity,
    hostHello(identity, {
      endpointId,
      runtimeId,
      metadata: options.metadata ?? defaultMetadata(),
      authorizedOwnerIds: options.authorizedOwnerIds ?? [],
    }),
  ));
  return { identity, peer, endpointId, runtimeId };
}

async function subscribe(owner, deviceIds) {
  const after = owner.peer.cursor();
  await owner.peer.sendJson(subscriptionFrame(deviceIds));
  return owner.peer.waitForJson((frame) => isFrame(frame, "endpoints"), after);
}

function isFrame(value, type) {
  return isRecord(value) && value.type === type;
}

function matchesEndpoint(frame, type, host) {
  return isFrame(frame, type)
    && frame.device_id === host.identity.id
    && frame.endpoint_id === host.endpointId
    && frame.runtime_instance_id === host.runtimeId;
}

function matchesRoute(frame, options) {
  return isFrame(frame, "route")
    && frame.device_id === options.deviceId
    && frame.endpoint_id === options.endpointId
    && frame.runtime_instance_id === options.runtimeId
    && frame.purpose === options.purpose
    && frame.ct === options.ct;
}

function snapshotContainsExactly(frame, hosts) {
  if (!isFrame(frame, "endpoints") || !Array.isArray(frame.endpoints) || frame.endpoints.length !== hosts.length) return false;
  return hosts.every((host) => frame.endpoints.some((endpoint) => (
    isRecord(endpoint)
      && endpoint.endpoint_id === host.endpointId
      && endpoint.runtime_instance_id === host.runtimeId
  )));
}

function assertPairingTarget(frame, requestId, code, host) {
  assert.ok(isFrame(frame, "pairing_target"), "expected pairing target");
  assert.ok(
    frame.in_reply_to === requestId
      && frame.code === code
      && frame.device_id === host.identity.id
      && frame.endpoint_id === host.endpointId
      && frame.runtime_instance_id === host.runtimeId,
    "pairing target must preserve correlation and current endpoint",
  );
}

function assertPairingError(frame, requestId, reason) {
  assert.ok(isFrame(frame, "pairing_code_error"), "expected pairing error");
  assert.ok(frame.in_reply_to === requestId && frame.reason === reason, "pairing error must preserve correlation and reason");
}

async function publishOffer(host, owner, code, expiresAt = Date.now() + OFFER_TTL_MS) {
  await host.peer.sendJson(pairingOfferFrame({
    code,
    endpointId: host.endpointId,
    runtimeId: host.runtimeId,
    expiresAt,
  }));
  const after = owner.peer.cursor();
  await host.peer.sendJson(endpointUpdateFrame({ metadata: defaultMetadata({ name: `pairing-barrier-${randomUUID()}` }) }));
  await owner.peer.waitForJson((frame) => matchesEndpoint(frame, "endpoint_updated", host), after);
}

async function resolveCode(owner, requestId, code) {
  const after = owner.peer.cursor();
  await owner.peer.sendJson(resolvePairingCodeFrame(requestId, code));
  return owner.peer.waitForJson(
    (frame) => isFrame(frame, "pairing_target") || isFrame(frame, "pairing_code_error"),
    after,
  );
}

const externalUrl = process.env.RELAY_TEST_URL;

test("Relay WebSocket black-box contract", { concurrency: false, timeout: 45_000 }, async (t) => {
  let handle;
  let url = externalUrl;
  if (url === undefined || url.length === 0) {
    const { startRelay } = await import("../dist/server.js");
    handle = await startRelay({ host: "127.0.0.1", port: 0 });
    url = `ws://127.0.0.1:${handle.port}`;
  }

  try {
    await t.test("authenticates and proves ready through an empty endpoint snapshot", async () => {
      await withScenario(url, async (track) => {
        const owner = await openOwner(url, track);
        const snapshot = await subscribe(owner, [owner.identity.id]);
        assert.ok(snapshotContainsExactly(snapshot, []), "unknown device subscription must return an empty snapshot");
      });
    });

    await t.test("closes an authentication attempt with a bad signature", async () => {
      await withScenario(url, async (track) => {
        const identity = createIdentity();
        const wrongIdentity = createIdentity();
        const { peer, nonce } = await beginAuthentication(url, ownerHello(identity));
        track(peer);
        const after = peer.cursor();
        await peer.sendJson({ type: "auth", sig: signNonce(wrongIdentity, nonce) });
        await peer.waitForClose(after);
      });
    });

    await t.test("closes a replayed authentication signature", async () => {
      await withScenario(url, async (track) => {
        const identity = createIdentity();
        const first = await beginAuthentication(url, ownerHello(identity));
        track(first.peer);
        const replaySignature = signNonce(identity, first.nonce);
        await first.peer.sendJson({ type: "auth", sig: replaySignature });
        const readySnapshot = await subscribe({ identity, peer: first.peer }, [identity.id]);
        assert.ok(snapshotContainsExactly(readySnapshot, []), "first authentication must become usable");

        const second = await beginAuthentication(url, ownerHello(identity));
        track(second.peer);
        const after = second.peer.cursor();
        await second.peer.sendJson({ type: "auth", sig: replaySignature });
        await second.peer.waitForClose(after);
      });
    });

    await t.test("closes noncanonical, unknown-field, and noninteger hello frames", async () => {
      await withScenario(url, async (track) => {
        const canonicalIdentity = createIdentity();
        const malformedHellos = [
          ownerHello(canonicalIdentity, { pubkey: nonCanonicalId(canonicalIdentity.id) }),
          ownerHello(createIdentity(), { extra: true }),
          hostHello(createIdentity(), { metadata: defaultMetadata({ pid: 1.5 }) }),
        ];
        for (const hello of malformedHellos) {
          const peer = track(await connectPeer(url));
          const after = peer.cursor();
          await peer.sendJson(hello);
          await peer.waitForClose(after);
        }
      });
    });

    await t.test("accepts metadata null and emits omitted metadata fields", async () => {
      await withScenario(url, async (track) => {
        const owner = await openOwner(url, track);
        const hostIdentity = createIdentity();
        const empty = await subscribe(owner, [hostIdentity.id]);
        assert.ok(snapshotContainsExactly(empty, []), "owner must be ready before host announcement");

        const after = owner.peer.cursor();
        const host = await openHost(url, track, {
          identity: hostIdentity,
          authorizedOwnerIds: [owner.identity.id],
          metadata: defaultMetadata({ name: null, cwd: null, pid: null, started_at: null }),
        });
        const announced = await owner.peer.waitForJson((frame) => matchesEndpoint(frame, "endpoint_announced", host), after);
        assert.ok(isRecord(announced.metadata) && announced.metadata.kind === "daemon", "announced metadata must retain kind");
        assert.ok(
          !Object.hasOwn(announced.metadata, "name")
            && !Object.hasOwn(announced.metadata, "cwd")
            && !Object.hasOwn(announced.metadata, "pid")
            && !Object.hasOwn(announced.metadata, "started_at"),
          "null input metadata values must be omitted from output",
        );
      });
    });

    await t.test("accepts Rust UUID layout values outside the shared codec UUID subset", async () => {
      await withScenario(url, async (track) => {
        const owner = await openOwner(url, track);
        const hostIdentity = createIdentity();
        const empty = await subscribe(owner, [hostIdentity.id]);
        assert.ok(snapshotContainsExactly(empty, []), "owner must be ready before host announcement");

        const after = owner.peer.cursor();
        const host = await openHost(url, track, {
          identity: hostIdentity,
          endpointId: "11111111-1111-0111-0111-111111111111",
          runtimeId: "22222222-2222-f222-c222-222222222222",
          authorizedOwnerIds: [owner.identity.id],
        });
        const announced = await owner.peer.waitForJson((frame) => matchesEndpoint(frame, "endpoint_announced", host), after);
        assert.ok(matchesEndpoint(announced, "endpoint_announced", host), "Rust-layout UUID endpoint must be announced unchanged");
      });
    });

    await t.test("routes opaque session payloads bidirectionally and injects the owner source", async () => {
      await withScenario(url, async (track) => {
        const owner = await openOwner(url, track);
        const host = await openHost(url, track, { authorizedOwnerIds: [owner.identity.id] });
        const snapshot = await subscribe(owner, [host.identity.id]);
        assert.ok(snapshotContainsExactly(snapshot, [host]), "authorized owner must discover host");

        const hostAfter = host.peer.cursor();
        await owner.peer.sendJson(routeFrame({
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          ct: OPAQUE_OWNER_TO_HOST,
        }));
        const toHost = await host.peer.waitForJson(
          (frame) => matchesRoute(frame, {
            deviceId: host.identity.id,
            endpointId: host.endpointId,
            runtimeId: host.runtimeId,
            purpose: "session",
            ct: OPAQUE_OWNER_TO_HOST,
          }),
          hostAfter,
        );
        assert.ok(toHost.source_owner_id === owner.identity.id, "owner route must receive canonical source injection");
        assert.ok(!Object.hasOwn(toHost, "target_owner_id"), "missing owner target must remain omitted");

        const ownerAfter = owner.peer.cursor();
        await host.peer.sendJson(routeFrame({
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          targetOwnerId: owner.identity.id,
          ct: OPAQUE_HOST_TO_OWNER,
        }));
        const toOwner = await owner.peer.waitForJson(
          (frame) => matchesRoute(frame, {
            deviceId: host.identity.id,
            endpointId: host.endpointId,
            runtimeId: host.runtimeId,
            purpose: "session",
            ct: OPAQUE_HOST_TO_OWNER,
          }),
          ownerAfter,
        );
        assert.ok(toOwner.target_owner_id === owner.identity.id, "host target must be preserved");
        assert.ok(!Object.hasOwn(toOwner, "source_owner_id"), "host route must omit source owner");
      });
    });

    await t.test("broadcasts a host route to each connection of the same owner", async () => {
      await withScenario(url, async (track) => {
        const ownerIdentity = createIdentity();
        const host = await openHost(url, track, { authorizedOwnerIds: [ownerIdentity.id] });
        const ownerA = await openOwner(url, track, ownerIdentity);
        const ownerB = await openOwner(url, track, ownerIdentity);
        const snapshotA = await subscribe(ownerA, [host.identity.id]);
        const snapshotB = await subscribe(ownerB, [host.identity.id]);
        assert.ok(snapshotContainsExactly(snapshotA, [host]) && snapshotContainsExactly(snapshotB, [host]), "each owner connection must receive its own snapshot");

        const afterA = ownerA.peer.cursor();
        const afterB = ownerB.peer.cursor();
        await host.peer.sendJson(routeFrame({
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          targetOwnerId: ownerIdentity.id,
          ct: OPAQUE_HOST_TO_OWNER,
        }));
        const expectedRoute = (frame) => matchesRoute(frame, {
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          ct: OPAQUE_HOST_TO_OWNER,
        }) && frame.target_owner_id === ownerIdentity.id;
        await Promise.all([
          ownerA.peer.waitForJson(expectedRoute, afterA),
          ownerB.peer.waitForJson(expectedRoute, afterB),
        ]);
      });
    });

    await t.test("replaces endpoint subscriptions and stops updates for removed devices", async () => {
      await withScenario(url, async (track) => {
        const owner = await openOwner(url, track);
        const hostAIdentity = createIdentity();
        const hostBIdentity = createIdentity();
        const empty = await subscribe(owner, [hostAIdentity.id, hostBIdentity.id]);
        assert.ok(snapshotContainsExactly(empty, []), "owner must be ready before both hosts announce");

        const announceAAfter = owner.peer.cursor();
        const hostA = await openHost(url, track, { identity: hostAIdentity, authorizedOwnerIds: [owner.identity.id] });
        await owner.peer.waitForJson((frame) => matchesEndpoint(frame, "endpoint_announced", hostA), announceAAfter);
        const announceBAfter = owner.peer.cursor();
        const hostB = await openHost(url, track, { identity: hostBIdentity, authorizedOwnerIds: [owner.identity.id] });
        await owner.peer.waitForJson((frame) => matchesEndpoint(frame, "endpoint_announced", hostB), announceBAfter);

        const snapshotA = await subscribe(owner, [hostA.identity.id]);
        assert.ok(snapshotContainsExactly(snapshotA, [hostA]), "first replacement subscription must contain only host A");
        const snapshotB = await subscribe(owner, [hostB.identity.id]);
        assert.ok(snapshotContainsExactly(snapshotB, [hostB]), "second replacement subscription must contain only host B");

        const noAUpdateAfter = owner.peer.cursor();
        await hostA.peer.sendJson(endpointUpdateFrame({ metadata: defaultMetadata({ name: "updated-a" }) }));
        await owner.peer.expectNoJson((frame) => matchesEndpoint(frame, "endpoint_updated", hostA), noAUpdateAfter, ABSENCE_TIMEOUT_MS);

        const bUpdateAfter = owner.peer.cursor();
        await hostB.peer.sendJson(endpointUpdateFrame({ metadata: defaultMetadata({ name: "updated-b" }) }));
        const update = await owner.peer.waitForJson((frame) => matchesEndpoint(frame, "endpoint_updated", hostB), bUpdateAfter);
        assert.ok(isRecord(update.metadata) && update.metadata.name === "updated-b", "retained subscription must receive metadata updates");
      });
    });

    await t.test("emits ended then announced when host ACL is revoked and restored", async () => {
      await withScenario(url, async (track) => {
        const owner = await openOwner(url, track);
        const hostIdentity = createIdentity();
        const empty = await subscribe(owner, [hostIdentity.id]);
        assert.ok(snapshotContainsExactly(empty, []), "owner must be ready before host announcement");
        const announcedAfter = owner.peer.cursor();
        const host = await openHost(url, track, { identity: hostIdentity, authorizedOwnerIds: [owner.identity.id] });
        await owner.peer.waitForJson((frame) => matchesEndpoint(frame, "endpoint_announced", host), announcedAfter);

        const endedAfter = owner.peer.cursor();
        await host.peer.sendJson(endpointUpdateFrame({ authorizedOwnerIds: [] }));
        await owner.peer.waitForJson((frame) => matchesEndpoint(frame, "endpoint_ended", host), endedAfter);

        const reannouncedAfter = owner.peer.cursor();
        await host.peer.sendJson(endpointUpdateFrame({ authorizedOwnerIds: [owner.identity.id] }));
        await owner.peer.waitForJson((frame) => matchesEndpoint(frame, "endpoint_announced", host), reannouncedAfter);
      });
    });

    await t.test("emits endpoint ended when the current host exits", async () => {
      await withScenario(url, async (track) => {
        const owner = await openOwner(url, track);
        const host = await openHost(url, track, { authorizedOwnerIds: [owner.identity.id] });
        const snapshot = await subscribe(owner, [host.identity.id]);
        assert.ok(snapshotContainsExactly(snapshot, [host]), "owner must discover host before exit");

        const after = owner.peer.cursor();
        await host.peer.closeGracefully();
        await owner.peer.waitForJson((frame) => matchesEndpoint(frame, "endpoint_ended", host), after);
      });
    });

    await t.test("drops unapproved sessions but delivers pairing routes on the same owner socket", async () => {
      await withScenario(url, async (track) => {
        const host = await openHost(url, track);
        const owner = await openOwner(url, track);
        const snapshot = await subscribe(owner, [host.identity.id]);
        assert.ok(snapshotContainsExactly(snapshot, []), "unapproved owner must not discover host");

        const sessionAfter = host.peer.cursor();
        await owner.peer.sendJson(routeFrame({
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          ct: "blocked-session",
        }));
        await host.peer.expectNoJson((frame) => matchesRoute(frame, {
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          ct: "blocked-session",
        }), sessionAfter, ABSENCE_TIMEOUT_MS);

        const pairingAfter = host.peer.cursor();
        await owner.peer.sendJson(routeFrame({
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "pairing",
          ct: "allowed-pairing",
        }));
        const pairingRoute = await host.peer.waitForJson((frame) => matchesRoute(frame, {
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "pairing",
          ct: "allowed-pairing",
        }), pairingAfter);
        assert.ok(pairingRoute.source_owner_id === owner.identity.id, "pairing route must prove the owner socket remains authenticated");
      });
    });

    await t.test("drops wrong-role, forged-source, and unknown ready frames while preserving valid traffic", async () => {
      await withScenario(url, async (track) => {
        const owner = await openOwner(url, track);
        const host = await openHost(url, track, { authorizedOwnerIds: [owner.identity.id] });
        const snapshot = await subscribe(owner, [host.identity.id]);
        assert.ok(snapshotContainsExactly(snapshot, [host]), "owner must be ready for survival barriers");

        const noRoleFrameAfter = host.peer.cursor();
        await owner.peer.sendJson(pairingOfferFrame({
          code: randomPairingCode(),
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          expiresAt: Date.now() + OFFER_TTL_MS,
        }));
        await host.peer.expectNoJson(() => true, noRoleFrameAfter, ABSENCE_TIMEOUT_MS);

        const validAfterWrongRole = host.peer.cursor();
        await owner.peer.sendJson(routeFrame({
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          ct: "owner-role-barrier",
        }));
        await host.peer.waitForJson((frame) => matchesRoute(frame, {
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          ct: "owner-role-barrier",
        }), validAfterWrongRole);

        const forgedAfter = host.peer.cursor();
        await owner.peer.sendJson(routeFrame({
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          sourceOwnerId: owner.identity.id,
          ct: "forged-source",
        }));
        await host.peer.expectNoJson((frame) => matchesRoute(frame, {
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          ct: "forged-source",
        }), forgedAfter, ABSENCE_TIMEOUT_MS);

        const validAfterForgery = host.peer.cursor();
        await owner.peer.sendJson(routeFrame({
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          ct: "forgery-barrier",
        }));
        await host.peer.waitForJson((frame) => matchesRoute(frame, {
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          ct: "forgery-barrier",
        }), validAfterForgery);

        const noHostRoleFrameAfter = owner.peer.cursor();
        await host.peer.sendJson(resolvePairingCodeFrame(randomUUID(), randomPairingCode()));
        await owner.peer.expectNoJson(() => true, noHostRoleFrameAfter, ABSENCE_TIMEOUT_MS);

        const ownerBarrierAfter = owner.peer.cursor();
        await host.peer.sendJson(routeFrame({
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          targetOwnerId: owner.identity.id,
          ct: "host-role-barrier",
        }));
        await owner.peer.waitForJson((frame) => matchesRoute(frame, {
          deviceId: host.identity.id,
          endpointId: host.endpointId,
          runtimeId: host.runtimeId,
          purpose: "session",
          ct: "host-role-barrier",
        }), ownerBarrierAfter);

        const noUnknownAfter = owner.peer.cursor();
        await owner.peer.sendJson({ type: "subscribe_endpoints", device_ids: [host.identity.id], extra: true });
        await owner.peer.expectNoJson(() => true, noUnknownAfter, ABSENCE_TIMEOUT_MS);
        const validSnapshot = await subscribe(owner, [host.identity.id]);
        assert.ok(snapshotContainsExactly(validSnapshot, [host]), "unknown ready frame must not close the owner socket");
      });
    });

    await t.test("keeps the new runtime authoritative after takeover and old host exit", async () => {
      await withScenario(url, async (track) => {
        const owner = await openOwner(url, track);
        const hostIdentity = createIdentity();
        const endpointId = randomUUID();
        const hostA = await openHost(url, track, {
          identity: hostIdentity,
          endpointId,
          authorizedOwnerIds: [owner.identity.id],
        });
        const snapshot = await subscribe(owner, [hostIdentity.id]);
        assert.ok(snapshotContainsExactly(snapshot, [hostA]), "owner must observe runtime A first");

        const updateAfter = owner.peer.cursor();
        const hostB = await openHost(url, track, {
          identity: hostIdentity,
          endpointId,
          authorizedOwnerIds: [owner.identity.id],
        });
        await owner.peer.waitForJson((frame) => matchesEndpoint(frame, "endpoint_updated", hostB), updateAfter);

        const oldAfter = hostA.peer.cursor();
        await owner.peer.sendJson(routeFrame({
          deviceId: hostIdentity.id,
          endpointId,
          runtimeId: hostA.runtimeId,
          purpose: "session",
          ct: "stale-runtime-route",
        }));
        await hostA.peer.expectNoJson((frame) => matchesRoute(frame, {
          deviceId: hostIdentity.id,
          endpointId,
          runtimeId: hostA.runtimeId,
          purpose: "session",
          ct: "stale-runtime-route",
        }), oldAfter, ABSENCE_TIMEOUT_MS);

        const currentAfter = hostB.peer.cursor();
        await owner.peer.sendJson(routeFrame({
          deviceId: hostIdentity.id,
          endpointId,
          runtimeId: hostB.runtimeId,
          purpose: "session",
          ct: "current-runtime-route",
        }));
        await hostB.peer.waitForJson((frame) => matchesRoute(frame, {
          deviceId: hostIdentity.id,
          endpointId,
          runtimeId: hostB.runtimeId,
          purpose: "session",
          ct: "current-runtime-route",
        }), currentAfter);

        await hostA.peer.closeGracefully();
        const afterOldExit = hostB.peer.cursor();
        await owner.peer.sendJson(routeFrame({
          deviceId: hostIdentity.id,
          endpointId,
          runtimeId: hostB.runtimeId,
          purpose: "session",
          ct: "post-old-exit-route",
        }));
        await hostB.peer.waitForJson((frame) => matchesRoute(frame, {
          deviceId: hostIdentity.id,
          endpointId,
          runtimeId: hostB.runtimeId,
          purpose: "session",
          ct: "post-old-exit-route",
        }), afterOldExit);
      });
    });

    await t.test("normalizes pairing codes and reports unknown and expired codes", async () => {
      await withScenario(url, async (track) => {
        const owner = await openOwner(url, track);
        const host = await openHost(url, track, { authorizedOwnerIds: [owner.identity.id] });
        const snapshot = await subscribe(owner, [host.identity.id]);
        assert.ok(snapshotContainsExactly(snapshot, [host]), "host must be registered before pairing offers");

        const validCode = randomPairingCode();
        await publishOffer(host, owner, validCode);
        const successRequest = randomUUID();
        assertPairingTarget(await resolveCode(owner, successRequest, validCode.toLowerCase()), successRequest, validCode, host);

        const unknownRequest = randomUUID();
        assertPairingError(await resolveCode(owner, unknownRequest, randomPairingCode()), unknownRequest, "unknown_code");

        const expiredCode = randomPairingCode();
        await publishOffer(host, owner, expiredCode, 0);
        const expiredRequest = randomUUID();
        assertPairingError(await resolveCode(owner, expiredRequest, expiredCode), expiredRequest, "expired_code");
      });
    });

    await t.test("preserves the first collision owner and replaces offers from the same host", async () => {
      await withScenario(url, async (track) => {
        const owner = await openOwner(url, track);
        const hostAIdentity = createIdentity();
        const hostBIdentity = createIdentity();
        const empty = await subscribe(owner, [hostAIdentity.id, hostBIdentity.id]);
        assert.ok(snapshotContainsExactly(empty, []), "owner must be ready before both hosts announce");
        const announcedAAfter = owner.peer.cursor();
        const hostA = await openHost(url, track, { identity: hostAIdentity, authorizedOwnerIds: [owner.identity.id] });
        await owner.peer.waitForJson((frame) => matchesEndpoint(frame, "endpoint_announced", hostA), announcedAAfter);
        const announcedBAfter = owner.peer.cursor();
        const hostB = await openHost(url, track, { identity: hostBIdentity, authorizedOwnerIds: [owner.identity.id] });
        await owner.peer.waitForJson((frame) => matchesEndpoint(frame, "endpoint_announced", hostB), announcedBAfter);

        const collisionCode = randomPairingCode();
        await publishOffer(hostA, owner, collisionCode);
        await publishOffer(hostB, owner, collisionCode);
        const collisionRequest = randomUUID();
        assertPairingTarget(await resolveCode(owner, collisionRequest, collisionCode), collisionRequest, collisionCode, hostA);

        const replacedCode = randomPairingCode();
        const replacementCode = randomPairingCode();
        await publishOffer(hostA, owner, replacedCode);
        await publishOffer(hostA, owner, replacementCode);
        const replacedRequest = randomUUID();
        assertPairingError(await resolveCode(owner, replacedRequest, replacedCode), replacedRequest, "unknown_code");
        const replacementRequest = randomUUID();
        assertPairingTarget(await resolveCode(owner, replacementRequest, replacementCode), replacementRequest, replacementCode, hostA);
      });
    });

    await t.test("returns rate limited after twelve pairing resolves on one owner connection", async () => {
      await withScenario(url, async (track) => {
        const owner = await openOwner(url, track);
        const ready = await subscribe(owner, [owner.identity.id]);
        assert.ok(snapshotContainsExactly(ready, []), "owner must be ready before rate-limit probes");
        const unknownCode = randomPairingCode();
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const requestId = randomUUID();
          assertPairingError(await resolveCode(owner, requestId, unknownCode), requestId, "unknown_code");
        }
        const limitedRequest = randomUUID();
        assertPairingError(await resolveCode(owner, limitedRequest, unknownCode), limitedRequest, "rate_limited");
      });
    });

    await t.test("removes a disconnected host pairing offer", async () => {
      await withScenario(url, async (track) => {
        const owner = await openOwner(url, track);
        const hostIdentity = createIdentity();
        const empty = await subscribe(owner, [hostIdentity.id]);
        assert.ok(snapshotContainsExactly(empty, []), "owner must be ready before host announcement");
        const announcedAfter = owner.peer.cursor();
        const host = await openHost(url, track, { identity: hostIdentity, authorizedOwnerIds: [owner.identity.id] });
        await owner.peer.waitForJson((frame) => matchesEndpoint(frame, "endpoint_announced", host), announcedAfter);
        const code = randomPairingCode();
        await publishOffer(host, owner, code);
        await host.peer.closeGracefully();
        const requestId = randomUUID();
        assertPairingError(await resolveCode(owner, requestId, code), requestId, "unknown_code");
      });
    });
  } finally {
    await handle?.close();
  }
});
