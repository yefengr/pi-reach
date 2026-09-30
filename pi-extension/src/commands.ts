import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { canonicalizeEd25519PublicKey, type Ed25519Keypair } from "./pairing/crypto.js";
import { clampPairTtlMs, qrSession, renderQRAscii, PAIRING_INVITE_TTL_MS } from "./pairing/qr.js";
import { listPeers, removePeer } from "./pairing/storage.js";
import { isValidRelayUrl, isWebSocketScheme, resolveRelayUrl, saveConfig } from "./config.js";
import type { InitialRelayResult } from "./runtime/relay_lifecycle.js";

export type { InitialRelayResult } from "./runtime/relay_lifecycle.js";

type CommandUiContext = Pick<ExtensionContext, "ui">;
type CommandStartContext = Pick<ExtensionContext, "ui" | "cwd">;
const PAIR_WIDGET_KEY = "pi-reach-pair-code";

export interface RemoteCommandDependencies {
  start(ctx: CommandStartContext): Promise<InitialRelayResult>;
  waitForInitialRelay(): Promise<InitialRelayResult>;
  stop(): void;
  state(): "idle" | "started";
  relayStatus(): string;
  relayUrl(): string | null;
  endpointIdentity(): Readonly<{ endpointId: string; runtimeInstanceId: string }>;
  activeOwnerCount(): number;
  isOwnerActive(ownerId: string): boolean;
  closeOwner(ownerId: string, reason: "peer_stop"): void;
  updateEndpoint(): Promise<void>;
  displayName(cwd?: string): string;
  keypair(): Ed25519Keypair | null;
  hasRelay(): boolean;
  publishPairingOffer(code: string, expiresAt: number): boolean;
  setCommandContext(ctx: ExtensionCommandContext): void;
  runInternalSessionNew(token: string, ctx: ExtensionCommandContext): Promise<void>;
}

function notify(ctx: CommandUiContext, text: string, kind: "info" | "warning" | "error" = "info"): void {
  try { ctx.ui.notify(text, kind); } catch { /* headless or stale context */ }
}

async function pair(ctx: CommandStartContext, args: string, deps: RemoteCommandDependencies): Promise<void> {
  const result = deps.state() === "idle" ? await deps.start(ctx) : await deps.waitForInitialRelay();
  if (result === "cancelled") {
    notify(ctx, `[pi-reach] Pair requires a Relay connection; current state: ${deps.relayStatus()}.`, "warning");
    return;
  }
  const keypair = deps.keypair();
  if (!keypair) {
    notify(ctx, "[pi-reach] Pair requires an available device identity.", "warning");
    return;
  }
  if (!deps.hasRelay()) {
    notify(ctx, `[pi-reach] Pair requires a Relay connection; current state: ${deps.relayStatus()}.`, "warning");
    return;
  }
  const ttl = /--ttl\s+(\d+)/.exec(args);
  const ttlMs = ttl ? clampPairTtlMs(Number(ttl[1]) * 1_000) : PAIRING_INVITE_TTL_MS;
  const invite = qrSession.issueCode(ttlMs);
  if (!deps.publishPairingOffer(invite.code, invite.expiresAt)) {
    qrSession.clear();
    notify(ctx, `[pi-reach] Pair requires a Relay connection; current state: ${deps.relayStatus()}.`, "warning");
    return;
  }
  try {
    ctx.ui.setWidget(PAIR_WIDGET_KEY, [
      "Scan to pair:",
      "",
      renderQRAscii(invite.code),
      "",
      `Pairing code: ${invite.code}`,
      `Expires at: ${new Date(invite.expiresAt).toLocaleTimeString()}`,
    ]);
  } catch { /* headless pairing still has a status message */ }
  notify(ctx, `[pi-reach] Pairing code ready until ${new Date(invite.expiresAt).toLocaleTimeString()}.`);
}

async function listDevices(ctx: CommandUiContext, deps: RemoteCommandDependencies): Promise<void> {
  const peers = await listPeers();
  if (!peers.length) {
    notify(ctx, "[pi-reach] No paired devices.");
    return;
  }
  notify(ctx, `[pi-reach] Paired devices:\n${peers.map((peer) => `* ${peer.remote_epk.slice(0, 8)} - ${peer.name}${deps.isOwnerActive(peer.remote_epk) ? " online" : ""}`).join("\n")}`);
}

async function revoke(args: string, ctx: CommandUiContext, deps: RemoteCommandDependencies): Promise<void> {
  const shortId = args.trim();
  if (!shortId) {
    notify(ctx, "[pi-reach] Usage: /pi-reach revoke <shortid>", "warning");
    return;
  }
  const matches = (await listPeers()).filter((peer) => peer.remote_epk.startsWith(shortId));
  if (matches.length !== 1) {
    notify(ctx, matches.length ? "[pi-reach] Ambiguous owner id." : "[pi-reach] No matching paired device.", "warning");
    return;
  }
  const peer = matches[0]!;
  await removePeer(peer.remote_epk);
  let ownerId = peer.remote_epk;
  try { ownerId = canonicalizeEd25519PublicKey(peer.remote_epk, "Owner public key"); } catch { /* retain cleanup for corrupt legacy records */ }
  deps.closeOwner(ownerId, "peer_stop");
  await deps.updateEndpoint();
  notify(ctx, `[pi-reach] Revoked: ${peer.name}`);
}

function status(ctx: CommandUiContext, deps: RemoteCommandDependencies): void {
  const url = deps.relayUrl() ?? resolveRelayUrl().url;
  const identity = deps.endpointIdentity();
  const detail = deps.state() === "idle"
    ? "off"
    : `${deps.relayStatus()}, endpoint=${identity.endpointId}, runtime=${identity.runtimeInstanceId}, owners=${deps.activeOwnerCount()}`;
  notify(ctx, `[pi-reach] Relay ${detail} (${url})`);
}

function setRelay(value: string, ctx: CommandUiContext): void {
  const url = value.trim();
  if (isWebSocketScheme(url)) {
    notify(ctx, "[pi-reach] Use http:// or https://; it is converted internally.", "warning");
    return;
  }
  if (!isValidRelayUrl(url)) {
    notify(ctx, "[pi-reach] Invalid Relay URL.", "warning");
    return;
  }
  saveConfig({ relay: url });
  notify(ctx, `[pi-reach] Relay set to ${url}.`);
}

export function persistModelDefault(provider: string, modelId: string): void {
  try {
    const path = join(process.cwd(), ".pi", "settings.json");
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { /* fresh file */ }
    config.defaultProvider = provider;
    config.defaultModel = modelId;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2));
  } catch { /* a live model switch must not fail because persistence failed */ }
}

async function command(args: string, ctx: ExtensionCommandContext, deps: RemoteCommandDependencies): Promise<void> {
  deps.setCommandContext(ctx);
  const [verb, ...rest] = args.trim().split(/\s+/);
  const value = rest.join(" ");
  try {
    switch (verb || "start") {
      case "start": await deps.start(ctx); return;
      case "stop": deps.stop(); notify(ctx, "[pi-reach] Stopped."); return;
      case "status": status(ctx, deps); return;
      case "pair": await pair(ctx, value, deps); return;
      case "devices": await listDevices(ctx, deps); return;
      case "revoke": await revoke(value, ctx, deps); return;
      case "set-relay": setRelay(value, ctx); return;
      case "config": notify(ctx, `[pi-reach] ${resolveRelayUrl().url}`); return;
      case "internal-session-new": await deps.runInternalSessionNew(value, ctx); return;
      default: await deps.start(ctx); return;
    }
  } catch (error) {
    notify(ctx, `[pi-reach] ${verb} failed: ${String(error)}`, "error");
  }
}

export function registerCommands(pi: ExtensionAPI, deps: RemoteCommandDependencies): void {
  const handler = (args: string, ctx: ExtensionCommandContext): Promise<void> => command(args, ctx, deps);
  pi.registerCommand("pi-reach", { description: "Connect this Pi endpoint to Pi Reach", handler });
  pi.registerCommand("pi-reach start", { description: "Connect this endpoint to Relay", handler: async (_, ctx) => handler("start", ctx) });
  pi.registerCommand("pi-reach stop", { description: "Disconnect this endpoint", handler: async (_, ctx) => handler("stop", ctx) });
  pi.registerCommand("pi-reach pair", { description: "Show an endpoint pairing QR", handler: async (args, ctx) => handler(`pair ${args}`, ctx) });
  pi.registerCommand("pi-reach devices", { description: "List locally paired Owners", handler: async (_, ctx) => handler("devices", ctx) });
  pi.registerCommand("pi-reach revoke", { description: "Revoke a locally paired Owner", handler: async (args, ctx) => handler(`revoke ${args}`, ctx) });
  pi.registerCommand("pi-reach set-relay", { description: "Set Relay URL", handler: async (args, ctx) => handler(`set-relay ${args}`, ctx) });
}
