import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";

import { expect, it } from "vitest";

import { createBoundedLogger } from "./logger.js";

it("bounds diagnostic writes while stderr is backpressured and resumes after drain", () => {
  const stream = Object.assign(new EventEmitter(), {
    writes: 0,
    write() { this.writes += 1; return false; },
  });
  const log = createBoundedLogger(stream as unknown as Pick<Writable, "write" | "once">);
  for (let index = 0; index < 10_000; index++) log({ event: "frame_dropped", outcome: "invalid" });
  expect(stream.writes).toBe(1);
  expect(stream.listenerCount("drain")).toBe(1);
  stream.emit("drain");
  log({ event: "authenticated", role: "owner" });
  expect(stream.writes).toBe(2);
  expect(stream.listenerCount("drain")).toBe(1);
});
