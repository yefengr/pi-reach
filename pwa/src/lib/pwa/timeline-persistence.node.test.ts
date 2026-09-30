import { expect, test } from "vitest";
import { beginTimelinePersistenceEpoch, enqueueTimelinePersistence } from "./timeline-persistence";

test("skips a queued replacement after a newer reset epoch", async () => {
  const owner = {};
  const firstEpoch = beginTimelinePersistenceEpoch(owner);
  let release!: () => void;
  let oldReplacementRan = false;
  let currentReplacementRan = false;
  const blocker = enqueueTimelinePersistence(owner, firstEpoch, async () => {
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await Promise.resolve();
  await Promise.resolve();
  const oldReplacement = enqueueTimelinePersistence(owner, firstEpoch, async () => { oldReplacementRan = true; });
  const nextEpoch = beginTimelinePersistenceEpoch(owner);
  const currentReplacement = enqueueTimelinePersistence(owner, nextEpoch, async () => { currentReplacementRan = true; });

  release();
  expect(await blocker).toBe(true);
  expect(await oldReplacement).toBe(false);
  expect(await currentReplacement).toBe(true);
  expect(oldReplacementRan).toBe(false);
  expect(currentReplacementRan).toBe(true);
});


test("serializes operations and skips work superseded before execution", async () => {
  const owner = {};
  const firstEpoch = beginTimelinePersistenceEpoch(owner);
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = enqueueTimelinePersistence(owner, firstEpoch, async () => {
    order.push("first-start");
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
    order.push("first-end");
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual(["first-start"]);

  const second = enqueueTimelinePersistence(owner, firstEpoch, async () => { order.push("second"); });
  const nextEpoch = beginTimelinePersistenceEpoch(owner);
  const stale = enqueueTimelinePersistence(owner, firstEpoch, async () => { order.push("stale"); });
  const current = enqueueTimelinePersistence(owner, nextEpoch, async () => { order.push("current"); });

  releaseFirst();
  expect(await first).toBe(true);
  expect(await second).toBe(false);
  expect(await stale).toBe(false);
  expect(await current).toBe(true);
  expect(order).toEqual(["first-start", "first-end", "current"]);
});
