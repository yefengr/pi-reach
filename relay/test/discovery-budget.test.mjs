import assert from "node:assert/strict";
import test from "node:test";

import {
  beginAuthentication,
  createIdentity,
  hostHello,
  isRecord,
  signNonce,
  subscriptionFrame,
} from "./helpers.mjs";
import {
  openHost,
  openOwner,
  waitForSocketClose,
  withLocalRelay,
  withPeers,
} from "./resources-helpers.mjs";

function endpointSnapshot(frame, deviceId, count) {
  return isRecord(frame) && frame.type === "endpoints" && frame.device_id === deviceId &&
    Array.isArray(frame.endpoints) && frame.endpoints.length === count;
}

async function expectCompleteSubscription(owner, deviceId, emptyDeviceId) {
  const after = owner.peer.cursor();
  await owner.peer.sendJson(subscriptionFrame([deviceId, emptyDeviceId]));
  const [full, empty] = await Promise.all([
    owner.peer.waitForJson((frame) => endpointSnapshot(frame, deviceId, 1), after),
    owner.peer.waitForJson((frame) => endpointSnapshot(frame, emptyDeviceId, 0), after),
  ]);
  assert.equal(full.endpoints[0].metadata.kind, "daemon");
  assert.equal(empty.endpoints.length, 0);
}

test("discovery capacity rejects a takeover while the owner keeps complete repeatable snapshots", async () => {
  const events = [];
  await withLocalRelay({
    limits: { maxSubscriptions: 2, maxDiscoveryBytes: 340, shutdownTimeoutMs: 100 },
    logger: (event) => events.push(event),
  }, async ({ url }) => {
    await withPeers(async (track) => {
      const ownerIdentity = createIdentity();
      const hostIdentity = createIdentity();
      const host = await openHost(url, track, {
        identity: hostIdentity,
        metadata: { kind: "daemon" },
        authorizedOwnerIds: [ownerIdentity.id],
      });
      const owner = await openOwner(url, track, ownerIdentity);
      const emptyDeviceId = createIdentity().id;
      await expectCompleteSubscription(owner, host.identity.id, emptyDeviceId);

      const replacementHello = hostHello(hostIdentity, {
        endpointId: host.endpointId,
        runtimeId: host.runtimeId,
        metadata: { kind: "daemon", name: "超".repeat(30) },
        authorizedOwnerIds: [ownerIdentity.id],
      });
      const { peer: replacement, nonce } = await beginAuthentication(url, replacementHello);
      track(replacement);
      const closed = waitForSocketClose(replacement.socket);
      await replacement.sendJson({ type: "auth", sig: signNonce(hostIdentity, nonce) });
      assert.equal((await closed).code, 1008);
      assert.ok(events.some((event) => event.event === "connection_rejected" && event.outcome === "discovery_capacity"));

      await expectCompleteSubscription(owner, host.identity.id, emptyDeviceId);
      assert.equal(host.peer.socket.readyState, host.peer.socket.OPEN);
    });
  });
});
