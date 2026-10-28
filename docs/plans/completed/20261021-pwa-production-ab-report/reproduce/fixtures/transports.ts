import {
  ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_IN_FLIGHT, ATTACHMENT_MAX_MESSAGE_BYTES,
} from "@pi-reach/protocol/session";
import type { ClientFrame, ServerFrame } from "@/lib/pi-reach/protocol-v2/frames";
import type { ControlFrame } from "@/lib/pi-reach/types";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { FIXTURE } from "./history";

export const fixtureErrors: string[] = [];
let history: TimelineEvent[] = [];
let activeRelay: RelayClient | null = null;
let activeChannel: PeerChannel | null = null;
let receivedFrames = 0;
let sentFrames = 0;
let pendingReplies = 0;
const requestCounts: Record<string, number> = {};
const responseCounts: Record<string, number> = {};
let working = false;

export function configureTransport(events: TimelineEvent[]): void {
  if (activeRelay || activeChannel) throw new Error("Fixture transport already started");
  history = events;
}

function metadata() {
  return { kind: "interactive" as const, name: "Performance fixture", cwd: "/ab", working };
}

export function transportSnapshot() {
  return {
    channelId: activeChannel?.channelId ?? "",
    receivedFrames, sentFrames, pendingReplies,
    requestCounts: { ...requestCounts }, responseCounts: { ...responseCounts },
    channelOpen: Boolean(activeChannel && !activeChannel.closed),
  };
}

export function receiveFrame(frame: unknown): void {
  if (!activeChannel || activeChannel.closed) throw new Error("No active fixture channel");
  activeChannel.receive(frame);
}

export function setWorking(value: boolean): void {
  working = value;
  if (!activeRelay || activeRelay.state !== "open") throw new Error("No active fixture relay");
  activeRelay.emit("control", {
    type: "endpoint_updated", device_id: FIXTURE.deviceId, endpoint_id: FIXTURE.endpointId,
    runtime_instance_id: FIXTURE.runtimeInstanceId, metadata: metadata(),
  });
}

type RelayEvents = { state: string; error: Error; control: ControlFrame; route: unknown };

export class RelayClient {
  state: "idle" | "open" | "closed" = "idle";
  private readonly listeners = new Map<keyof RelayEvents, Set<(value: unknown) => void>>();

  constructor(_options?: unknown) { activeRelay = this; }

  on<K extends keyof RelayEvents>(event: K, callback: (value: RelayEvents[K]) => void): () => void {
    const callbacks = this.listeners.get(event) ?? new Set<(value: unknown) => void>();
    this.listeners.set(event, callbacks);
    const listener = callback as (value: unknown) => void;
    callbacks.add(listener);
    return () => { callbacks.delete(listener); };
  }

  emit<K extends keyof RelayEvents>(event: K, value: RelayEvents[K]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  async connect(): Promise<void> { this.state = "open"; }

  subscribeEndpoints(deviceIds: string[]): boolean {
    if (this.state !== "open") return false;
    queueMicrotask(() => {
      if (this.state !== "open") return;
      for (const deviceId of deviceIds) {
        if (deviceId !== FIXTURE.deviceId) {
          fixtureErrors.push("Unexpected fixture device subscription");
          continue;
        }
        this.emit("control", { type: "endpoints", device_id: deviceId, endpoints: [{
          endpoint_id: FIXTURE.endpointId, runtime_instance_id: FIXTURE.runtimeInstanceId, metadata: metadata(),
        }] });
      }
    });
    return true;
  }

  sendControl(_frame: unknown): boolean {
    fixtureErrors.push("Unexpected fixture Relay control request");
    return false;
  }

  sendRoute(): boolean {
    fixtureErrors.push("Unexpected encoded route in offline fixture");
    return false;
  }

  close(_code?: number, _reason?: string): void {
    this.state = "closed";
    if (activeRelay === this) activeRelay = null;
    this.emit("state", "closed");
  }
}

type PeerOptions = {
  channelId?: string;
  endpoint: { deviceId: string; endpointId: string; runtimeInstanceId: string };
  relay: unknown;
  onFrame?: (frame: ServerFrame) => void;
  onMalformed?: (message: string) => void;
};

export class PeerChannel {
  readonly channelId = "ab-channel";
  closed = false;
  constructor(private readonly options: PeerOptions) { activeChannel = this; }

  receive(frame: unknown): void {
    if (this.closed) throw new Error("Fixture channel is closed");
    receivedFrames += 1;
    // 与既有 PwaApp browser mock 一致：绕过运输编解码，不绕过 onFrame 消费者。
    this.options.onFrame?.(frame as ServerFrame);
  }

  private reply(frame: ServerFrame): void {
    pendingReplies += 1;
    queueMicrotask(() => {
      pendingReplies -= 1;
      if (this.closed) return;
      responseCounts[frame.type] = (responseCounts[frame.type] ?? 0) + 1;
      this.receive(frame);
    });
  }

  send(frame: ClientFrame): boolean {
    if (this.closed) return false;
    sentFrames += 1;
    requestCounts[frame.type] = (requestCounts[frame.type] ?? 0) + 1;
    const direct = { protocol_version: 2 as const, target_channel_id: this.channelId, in_reply_to: frame.id };
    switch (frame.type) {
      case "session_hello":
        this.reply({ ...direct, type: "session_ready", session_id: FIXTURE.sessionId,
          leaf_id: FIXTURE.leafId, self_sender_ref: FIXTURE.senderRef, head_seq: history.length });
        return true;
      case "session_sync": {
        const before = frame.before ?? history.length + 1;
        const events = history.filter((event) => event.event_seq! < before).slice(-(frame.limit ?? 80));
        const firstSequence = events[0]?.event_seq;
        this.reply({ ...direct, type: "session_history_chunk", session_id: FIXTURE.sessionId,
          leaf_id: FIXTURE.leafId, chunk_index: 0, events, fragments: [], final_chunk: true,
          ...(firstSequence !== undefined && firstSequence > 1 ? { eos: false as const, next_before: firstSequence } : { eos: true as const }),
        });
        return true;
      }
      case "attachment_capabilities_request":
        this.reply({ ...direct, type: "attachment_capabilities", session_id: FIXTURE.sessionId,
          upload_scope: "ab-uploads", max_file_bytes: ATTACHMENT_MAX_FILE_BYTES,
          max_message_bytes: ATTACHMENT_MAX_MESSAGE_BYTES, max_attachments: ATTACHMENT_MAX_COUNT,
          chunk_bytes: ATTACHMENT_CHUNK_BYTES, max_in_flight: ATTACHMENT_MAX_IN_FLIGHT });
        return true;
      case "list_models": {
        const model = { id: "ab-model", name: "Fixture model", provider: "ab-provider", reasoning: true, context_window: 128000, vision: false };
        this.reply({ ...direct, type: "models_list", models: [model], current: model, thinking_level: "off" });
        return true;
      }
      case "extension_info_request":
        this.reply({ ...direct, type: "extension_info", version: "0.0.0-fixture" });
        return true;
      case "ping":
        this.reply({ ...direct, type: "pong" });
        return true;
      case "user_message_observed": return true;
      default:
        fixtureErrors.push(`Unexpected fixture client request: ${frame.type}`);
        return false;
    }
  }

  sendPairRequest(frame: Extract<ClientFrame, { type: "pair_request" }>): boolean { return this.send(frame); }

  close(): void {
    this.closed = true;
    if (activeChannel === this) activeChannel = null;
  }
}
