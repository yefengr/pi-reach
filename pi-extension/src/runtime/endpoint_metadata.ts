import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EndpointMetadata } from "../transport/relay_client.js";

export const UNTITLED_SESSION_NAME = "Untitled session";

type SessionNameSource = Pick<SessionManager, "getSessionName"> | null | undefined;

type EndpointMetadataInput = {
  sessionManager: SessionNameSource;
  cwd: string;
  model?: string;
  thinking?: string;
  working: boolean;
};

export function currentSessionName(sessionManager: SessionNameSource): string {
  const name = sessionManager?.getSessionName?.();
  return name?.trim() || UNTITLED_SESSION_NAME;
}

export function buildEndpointMetadata({
  sessionManager,
  cwd,
  model,
  thinking,
  working,
}: EndpointMetadataInput): EndpointMetadata {
  return {
    kind: "interactive",
    name: currentSessionName(sessionManager),
    cwd,
    pid: process.pid,
    started_at: Date.now(),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    working,
  };
}
