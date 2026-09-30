import type { Writable } from "node:stream";

import type { RelayLogEvent } from "./server.js";

export function createBoundedLogger(stream: Pick<Writable, "write" | "once">): (event: RelayLogEvent) => void {
  let blocked = false;
  return (event) => {
    // 日志消费变慢时丢弃后续诊断事件，不把 stderr 变成无界消息缓冲。
    if (blocked) return;
    if (!stream.write(`${JSON.stringify(event)}\n`)) {
      blocked = true;
      stream.once("drain", () => { blocked = false; });
    }
  };
}
