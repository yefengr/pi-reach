import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ClientFrame } from "../protocol/v2/index.js";
import { V2PeerChannel, type HostRouteIdentity } from "../transport/peer_channel.js";
import type { RelayClient } from "../transport/relay_client.js";
import { TimelineV2Service, type V2ServiceOptions } from "../timeline/v2_service.js";
import type { TimelineRuntime } from "../timeline/runtime.js";
import type { UserDeliveryBinding } from "../timeline/user_delivery_binding.js";
import type { AttachmentDelivery } from "../timeline/attachment_delivery.js";

export type OwnerBinding = { channel: V2PeerChannel; service: TimelineV2Service; sessionId: string; leafId: string | null };
export type CreateOwnerBindingOptions = {
  relayClient: RelayClient;
  ownerId: string;
  manager: SessionManager;
  runtime: TimelineRuntime;
  identity: HostRouteIdentity;
  extensionVersion: string;
  delivery: UserDeliveryBinding;
  attachments: AttachmentDelivery;
  onFrame: (frame: ClientFrame) => void;
  onTurn: (id: string) => void;
} & Pick<V2ServiceOptions, "onCancel" | "onAction" | "onListModels">;

export function createOwnerBinding(options: CreateOwnerBindingOptions): OwnerBinding {
  const { ownerId, manager, runtime, delivery, attachments } = options;
  const channel = new V2PeerChannel(options.relayClient, ownerId, options.identity, options.onFrame);
  let service!: TimelineV2Service;
  service = new TimelineV2Service({ sessionManager: manager, senderRef: ownerId,
    extensionVersion: options.extensionVersion, runtime,
    onAttachmentReplay: (frame) => attachments.replay(frame, ownerId, manager, runtime),
    onUserMessage: (frame, correlation) => {
      options.onTurn(frame.client_request_id);
      return delivery.submit(frame, correlation, { ownerId, sessionId: manager.getSessionId(),
        leafId: manager.getLeafId() ?? null, service, clientRequestId: frame.client_request_id });
    },
    onQueueSnapshot: () => delivery.snapshot(ownerId, service),
    onQueuedMessageClear: (targetId) => delivery.clearQueued(ownerId, service, targetId),
    onQueuedMessageSteer: (targetId) => delivery.steerQueued(ownerId, service, targetId).kind,
    onCancel: options.onCancel, onAction: options.onAction, onListModels: options.onListModels,
  });
  return { channel, service, sessionId: manager.getSessionId(), leafId: manager.getLeafId() ?? null };
}
