import process from "node:process";
import { pathToFileURL } from "node:url";

import { loadCliConfig } from "./config.js";
import { createBoundedLogger } from "./logger.js";
import { startRelay, type RelayHandle } from "./server.js";

const logEvent = createBoundedLogger(process.stderr);

export async function runCli(): Promise<void> {
  const config = loadCliConfig();
  const relay = await startRelay({ ...config, logger: logEvent });
  // 先注册信号处理再宣布就绪：Linux 上写管道是同步的，读到 relay_listening 的一方可能立刻发送 SIGTERM。
  installShutdown(relay);
  process.stderr.write(`${JSON.stringify({ event: "relay_listening", host: config.host, port: relay.port })}\n`);
}

function installShutdown(relay: RelayHandle): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void relay.close().catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({ event: "shutdown_failed", error: errorName(error) })}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  runCli().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ event: "startup_failed", error: errorName(error) })}\n`);
    process.exitCode = 1;
  });
}
