import { useEffect } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import type { ClientFrame, ServerFrame } from "@/lib/pi-reach/protocol-v2/frames";
import type { ControlFrame, ControlOutbound } from "@/lib/pi-reach/types";
import type { RelayClient } from "@/lib/pi-reach/relay-client";
import type { DevicePairingController, DevicePairingResult } from "./use-device-pairing";
import { type PairingErrorCode, useDevicePairing } from "./use-device-pairing";

const deviceId = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const endpointId = "123e4567-e89b-42d3-a456-426614174001";
const runtimeInstanceId = "123e4567-e89b-42d3-a456-426614174002";
const code = "K7MP4Q2D";

type PairOkFrame = Extract<ServerFrame, { type: "pair_ok" }>;
type PairErrorFrame = Extract<ServerFrame, { type: "pair_error" }>;
type RelayHarness = {
  state: "open" | "closed";
  connectCalls: number;
  closeCalls: number;
  resolveFrames: Array<Extract<ControlOutbound, { type: "resolve_pairing_code" }>>;
  closeListeners: Set<() => void>;
  controlListeners: Set<(frame: ControlFrame) => void>;
  emitClose: () => void;
  emitControl: (frame: ControlFrame) => void;
};
type ChannelHarness = {
  pairRequestFrames: Array<Extract<ClientFrame, { type: "pair_request" }>>;
  closeCalls: number;
  emitPairOk: (frame: PairOkFrame) => void;
  emitPairError: (frame: PairErrorFrame) => void;
  emitMalformed: (reason: string) => void;
};

const harness = vi.hoisted(() => ({
  relay: null as RelayHarness | null,
  channels: [] as ChannelHarness[],
  nextSendResults: [] as boolean[],
}));

vi.mock("@/lib/pi-reach/peer-channel", () => ({
  PeerChannel: class {
    private readonly channel: ChannelHarness;

    constructor(options: {
      onPairOk?: (frame: PairOkFrame) => void;
      onPairError?: (frame: PairErrorFrame) => void;
      onMalformed?: (reason: string) => void;
    }) {
      this.channel = {
        pairRequestFrames: [],
        closeCalls: 0,
        emitPairOk: (frame) => options.onPairOk?.(frame),
        emitPairError: (frame) => options.onPairError?.(frame),
        emitMalformed: (reason) => options.onMalformed?.(reason),
      };
      harness.channels.push(this.channel);
    }

    sendPairRequest(frame: Extract<ClientFrame, { type: "pair_request" }>): boolean {
      const result = harness.nextSendResults.shift() ?? true;
      if (result) this.channel.pairRequestFrames.push(frame);
      return result;
    }

    close(): void {
      this.channel.closeCalls += 1;
    }
  },
}));

function createRelay(): RelayHarness {
  const relay: RelayHarness = {
    state: "open",
    connectCalls: 0,
    closeCalls: 0,
    resolveFrames: [],
    closeListeners: new Set(),
    controlListeners: new Set(),
    emitClose: () => {
      relay.state = "closed";
      for (const listener of relay.closeListeners) listener();
    },
    emitControl: (frame) => {
      for (const listener of relay.controlListeners) listener(frame);
    },
  };
  return relay;
}

function attachRelayMethods(relay: RelayHarness): RelayClient {
  return Object.assign(relay, {
    on(event: string, callback: (value?: unknown) => void) {
      if (event === "close") relay.closeListeners.add(callback as () => void);
      if (event === "control") relay.controlListeners.add(callback as (frame: ControlFrame) => void);
      return () => {
        if (event === "close") relay.closeListeners.delete(callback as () => void);
        if (event === "control") relay.controlListeners.delete(callback as (frame: ControlFrame) => void);
      };
    },
    async connect() {
      relay.connectCalls += 1;
      relay.state = "open";
    },
    sendControl(frame: ControlOutbound) {
      if (relay.state !== "open" || frame.type !== "resolve_pairing_code") return false;
      relay.resolveFrames.push(frame);
      return true;
    },
    close() {
      relay.closeCalls += 1;
      relay.state = "closed";
    },
  }) as unknown as RelayClient;
}

function target(requestId: string, targetCode = code): Extract<ControlFrame, { type: "pairing_target" }> {
  return { type: "pairing_target", in_reply_to: requestId, code: targetCode, device_id: deviceId, endpoint_id: endpointId, runtime_instance_id: runtimeInstanceId };
}

function PairingHarness({ relay, onController, onPaired, onError }: { relay: RelayClient; onController: (controller: DevicePairingController) => void; onPaired: (result: DevicePairingResult) => Promise<void>; onError: (error: PairingErrorCode | null) => void }) {
  const controller = useDevicePairing({ getOwnerRelay: () => relay, relayUrl: "https://relay.example.test", onPaired, onError });
  useEffect(() => { onController(controller); }, [controller, onController]);
  return <output data-testid="pairing-state">{controller.state}</output>;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function renderController(onPaired: (result: DevicePairingResult) => Promise<void>) {
  const relay = createRelay();
  harness.relay = relay;
  let current: DevicePairingController | null = null;
  const errors: Array<PairingErrorCode | null> = [];
  const screen = await renderPwa(<PairingHarness relay={attachRelayMethods(relay)} onController={(controller) => { current = controller; }} onPaired={onPaired} onError={(message) => { errors.push(message); }} />);
  await vi.waitFor(() => expect(current).not.toBeNull());
  return {
    relay,
    screen,
    errors,
    controller: () => {
      if (!current) throw new Error("Pairing controller did not mount.");
      return current;
    },
  };
}

beforeEach(() => {
  harness.relay = null;
  harness.channels.length = 0;
  harness.nextSendResults.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

test("normalizes a scanned or manually entered code through the same controller path", async () => {
  const onPaired = vi.fn<(result: DevicePairingResult) => Promise<void>>(async () => undefined);
  const { controller, relay, screen } = await renderController(onPaired);
  try {
    controller().open();
    const pairing = controller().pairFromCode("  k7mp-4q2d  ");
    await vi.waitFor(() => expect(relay.resolveFrames).toHaveLength(1));
    expect(relay.resolveFrames[0]).toMatchObject({ type: "resolve_pairing_code", code, request_id: expect.any(String) });
    relay.emitControl(target(relay.resolveFrames[0]!.request_id));
    await vi.waitFor(() => expect(harness.channels).toHaveLength(1));
    expect(harness.channels[0]?.pairRequestFrames[0]).toMatchObject({ type: "pair_request", code, id: relay.resolveFrames[0]!.request_id });
    const request = harness.channels[0]!.pairRequestFrames[0]!;
    harness.channels[0]!.emitPairOk({ protocol_version: 2, type: "pair_ok", in_reply_to: request.id, session_name: "test-session", session_started_at: Date.now(), endpoint_id: endpointId, hostname: "paired-host" });
    await pairing;
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(relay.closeCalls).toBe(0);
  } finally {
    await screen.unmount();
  }
});

test("rejects invalid codes without opening a transport", async () => {
  const { controller, relay, errors, screen } = await renderController(async () => undefined);
  try {
    controller().open();
    await controller().pairFromCode("not-a-code");
    expect(errors.at(-1)).toBe("invalid_code");
    await vi.waitFor(() => expect(controller().error).toBe("invalid_code"));
    expect(relay.resolveFrames).toHaveLength(0);
    expect(harness.channels).toHaveLength(0);
  } finally {
    await screen.unmount();
  }
});

test("surfaces a matching Relay resolve error and ignores a late request", async () => {
  const onPaired = vi.fn<(result: DevicePairingResult) => Promise<void>>(async () => undefined);
  const { controller, relay, errors, screen } = await renderController(onPaired);
  try {
    controller().open();
    const pairing = controller().pairFromCode(code);
    await vi.waitFor(() => expect(relay.resolveFrames).toHaveLength(1));
    const requestId = relay.resolveFrames[0]!.request_id;
    relay.emitControl({ type: "pairing_code_error", in_reply_to: "stale", reason: "unknown_code" });
    relay.emitControl({ type: "pairing_code_error", in_reply_to: requestId, reason: "expired_code" });
    await pairing;
    expect(errors.at(-1)).toBe("expired_code");
    await vi.waitFor(() => expect(controller().error).toBe("expired_code"));
    expect(onPaired).not.toHaveBeenCalled();
    expect(harness.channels).toHaveLength(0);
  } finally {
    await screen.unmount();
  }
});

test("retries the same resolve and pair request id after Relay close", async () => {
  const onPaired = vi.fn<(result: DevicePairingResult) => Promise<void>>(async () => undefined);
  const { controller, relay, screen } = await renderController(onPaired);
  try {
    controller().open();
    const pairing = controller().pairFromCode(code);
    await vi.waitFor(() => expect(relay.resolveFrames).toHaveLength(1));
    relay.emitClose();
    await vi.waitFor(() => expect(relay.resolveFrames).toHaveLength(2));
    expect(relay.resolveFrames[1]).toEqual(relay.resolveFrames[0]);
    relay.emitControl(target(relay.resolveFrames[1]!.request_id));
    await vi.waitFor(() => expect(harness.channels).toHaveLength(1));
    const request = harness.channels[0]!.pairRequestFrames[0]!;
    harness.channels[0]!.emitPairOk({ protocol_version: 2, type: "pair_ok", in_reply_to: request.id, session_name: "recovered", session_started_at: Date.now(), endpoint_id: endpointId });
    await pairing;
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(relay.closeCalls).toBe(0);
  } finally {
    await screen.unmount();
  }
});

test("retries once after timeout, then stops", async () => {
  vi.useFakeTimers();
  const { controller, relay, errors, screen } = await renderController(async () => undefined);
  try {
    controller().open();
    const pairing = controller().pairFromCode(code);
    await flushMicrotasks();
    expect(relay.resolveFrames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();
    expect(relay.resolveFrames).toHaveLength(2);
    expect(relay.resolveFrames[1]).toEqual(relay.resolveFrames[0]);
    await vi.advanceTimersByTimeAsync(15_000);
    await pairing;
    expect(errors.at(-1)).toBe("failed");
    expect(relay.closeCalls).toBe(0);
  } finally {
    await screen.unmount();
    vi.useRealTimers();
  }
});

test("cancels an active attempt and ignores a late pair_ok", async () => {
  const onPaired = vi.fn<(result: DevicePairingResult) => Promise<void>>(async () => undefined);
  const { controller, relay, screen } = await renderController(onPaired);
  try {
    controller().open();
    const pairing = controller().pairFromCode(code);
    await vi.waitFor(() => expect(relay.resolveFrames).toHaveLength(1));
    relay.emitControl(target(relay.resolveFrames[0]!.request_id));
    await vi.waitFor(() => expect(harness.channels).toHaveLength(1));
    const channel = harness.channels[0]!;
    const requestId = channel.pairRequestFrames[0]!.id;
    controller().close();
    await pairing;
    channel.emitPairOk({ protocol_version: 2, type: "pair_ok", in_reply_to: requestId, session_name: "late", session_started_at: Date.now(), endpoint_id: endpointId });
    expect(onPaired).not.toHaveBeenCalled();
    expect(channel.closeCalls).toBe(1);
    expect(relay.closeCalls).toBe(0);
  } finally {
    await screen.unmount();
  }
});

test("cleans an active attempt on unmount and isolates late responses", async () => {
  const onPaired = vi.fn<(result: DevicePairingResult) => Promise<void>>(async () => undefined);
  const { controller, relay, screen } = await renderController(onPaired);
  controller().open();
  const pairing = controller().pairFromCode(code);
  await vi.waitFor(() => expect(relay.resolveFrames).toHaveLength(1));
  relay.emitControl(target(relay.resolveFrames[0]!.request_id));
  await vi.waitFor(() => expect(harness.channels).toHaveLength(1));
  const channel = harness.channels[0]!;
  await screen.unmount();
  channel.emitPairOk({ protocol_version: 2, type: "pair_ok", in_reply_to: channel.pairRequestFrames[0]!.id, session_name: "late", session_started_at: Date.now(), endpoint_id: endpointId });
  await pairing;
  expect(onPaired).not.toHaveBeenCalled();
  expect(channel.closeCalls).toBe(1);
  expect(relay.closeCalls).toBe(0);
});

test.each([
  ["token_unknown", "unknown_code"],
  ["token_expired", "expired_code"],
  ["token_consumed", "consumed_code"],
  ["internal_error", "failed"],
] as const)("maps the Pi pair_error %s to the %s pairing failure", async (piCode, expected) => {
  const { controller, relay, errors, screen } = await renderController(async () => undefined);
  try {
    controller().open();
    const pairing = controller().pairFromCode(code);
    await vi.waitFor(() => expect(relay.resolveFrames).toHaveLength(1));
    relay.emitControl(target(relay.resolveFrames[0]!.request_id));
    await vi.waitFor(() => expect(harness.channels).toHaveLength(1));
    const request = harness.channels[0]!.pairRequestFrames[0]!;
    harness.channels[0]!.emitPairError({ protocol_version: 2, type: "pair_error", in_reply_to: request.id, code: piCode, message: "raw extension text" });
    await pairing;
    expect(errors.at(-1)).toBe(expected);
    await vi.waitFor(() => expect(controller().state).toBe("scanning"));
  } finally {
    await screen.unmount();
  }
});
