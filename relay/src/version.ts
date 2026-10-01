import { readFileSync } from "node:fs";
import { decodeControlFrame } from "@pi-reach/protocol/outer";

function readRelayVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  const frame = decodeControlFrame({ type: "relay_info", version: pkg.version });
  if (frame?.type !== "relay_info") throw new Error("Pi Reach Relay package has an invalid version");
  return frame.version;
}

export const RELAY_VERSION = readRelayVersion();
