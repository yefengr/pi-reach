import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RemoteCommandDependencies } from "./commands.js";

const peers = vi.hoisted(() => [] as { name: string; remote_epk: string; paired_at: string }[]);
const removePeer = vi.hoisted(() => vi.fn(async (ownerId: string) => {
  const index = peers.findIndex((peer) => peer.remote_epk === ownerId);
  if (index < 0) return false;
  peers.splice(index, 1);
  return true;
}));
vi.mock("./pairing/storage.js", () => ({
  listPeers: vi.fn(() => Promise.resolve([...peers])),
  removePeer,
}));

const { registerCommands } = await import("./commands.js");

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function commandContext() {
  return { cwd: "/tmp/pi-reach-command-test", ui: { notify: vi.fn(), setWidget: vi.fn() } };
}

function registerPair(deps: RemoteCommandDependencies): { commands: Map<string, CommandHandler>; handler: CommandHandler; revokeHandler: CommandHandler } {
  const commands = new Map<string, CommandHandler>();
  const pi = {
    registerCommand: vi.fn((name: string, definition: { handler: CommandHandler }) => commands.set(name, definition.handler)),
  } as unknown as ExtensionAPI;
  registerCommands(pi, deps);
  return { commands, handler: commands.get("pi-reach pair")!, revokeHandler: commands.get("pi-reach revoke")! };
}

function dependencies(overrides: Partial<RemoteCommandDependencies> = {}): RemoteCommandDependencies {
  return {
    start: vi.fn().mockResolvedValue("completed"),
    waitForInitialRelay: vi.fn().mockResolvedValue("completed"),
    stop: vi.fn(),
    state: vi.fn(() => "started"),
    relayStatus: vi.fn(() => "connected"),
    relayUrl: vi.fn(() => "https://relay.example.test"),
    endpointIdentity: vi.fn(() => ({ endpointId: "11f4842b-726f-4c2d-8c86-c66ddf1f1d7a", runtimeInstanceId: "42f4842b-726f-4c2d-8c86-c66ddf1f1d7a" })),
    activeOwnerCount: vi.fn(() => 0),
    isOwnerActive: vi.fn(() => false),
    closeOwner: vi.fn(),
    updateEndpoint: vi.fn().mockResolvedValue(undefined),
    displayName: vi.fn(() => "Local Pi"),
    keypair: vi.fn(() => ({ publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(64).fill(2) })),
    hasRelay: vi.fn(() => true),
    publishPairingOffer: vi.fn(() => true),
    setCommandContext: vi.fn(),
    runInternalSessionNew: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(() => {
  peers.length = 0;
  removePeer.mockClear();
  vi.restoreAllMocks();
});

describe("pair command", () => {
  test("reports reconnecting without generating a QR", async () => {
    const deps = dependencies({ hasRelay: vi.fn(() => false), relayStatus: vi.fn(() => "reconnecting") });
    const { handler } = registerPair(deps);
    const ctx = commandContext();

    await handler("", ctx as unknown as ExtensionCommandContext);

    expect(deps.waitForInitialRelay).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith("[pi-reach] Pair requires a Relay connection; current state: reconnecting.", "warning");
  });

  test("renders pairing details in a TUI-only widget", async () => {
    const deps = dependencies();
    const { handler } = registerPair(deps);
    const ctx = commandContext();

    await handler("", ctx as unknown as ExtensionCommandContext);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "pi-reach-pair-code",
      expect.arrayContaining(["Scan to pair:", expect.stringMatching(/^Pairing code: [0-9A-HJKMNP-TV-Z]{8}$/), expect.stringContaining("Expires at:")]),
    );
    expect(deps.publishPairingOffer).toHaveBeenCalledWith(expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{8}$/), expect.any(Number));
  });
});

describe("revoke command", () => {
  test("closes the target before updating Relay ACL", async () => {
    const ownerId = Buffer.alloc(32, 7).toString("base64");
    peers.push({ name: "Owner B", remote_epk: ownerId, paired_at: "now" });
    const calls: string[] = [];
    const deps = dependencies({
      closeOwner: vi.fn(() => { calls.push("closeOwner"); }),
      updateEndpoint: vi.fn(async () => { calls.push("updateEndpoint"); }),
    });
    const { revokeHandler } = registerPair(deps);

    await revokeHandler(ownerId.slice(0, 8), commandContext() as unknown as ExtensionCommandContext);

    expect(removePeer).toHaveBeenCalledWith(ownerId);
    expect(deps.closeOwner).toHaveBeenCalledWith(ownerId, "peer_stop");
    expect(calls).toEqual(["closeOwner", "updateEndpoint"]);
  });
});

test("base command starts the current Pi endpoint", async () => {
  const deps = dependencies();
  const { commands } = registerPair(deps);

  await commands.get("pi-reach")!("", commandContext() as unknown as ExtensionCommandContext);

  expect(deps.start).toHaveBeenCalledOnce();
});

test("registers only Pi extension commands", () => {
  const { commands } = registerPair(dependencies());
  expect([...commands.keys()]).toEqual([
    "pi-reach",
    "pi-reach start",
    "pi-reach stop",
    "pi-reach pair",
    "pi-reach devices",
    "pi-reach revoke",
    "pi-reach set-relay",
  ]);
});
