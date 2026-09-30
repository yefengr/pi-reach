export type {
  Base64Variant,
  EndpointMetadata,
  EndpointInfo,
  RoutePurpose,
  RouteFrame,
  PairingTargetControl,
  PairingCodeErrorReason,
  PairingCodeErrorControl,
  EndpointsControl,
  EndpointAnnouncedControl,
  EndpointUpdatedControl,
  EndpointEndedControl,
  ControlFrame,
  ControlOutbound,
  RelayFrame,
} from "@pi-reach/protocol/outer";

export interface OwnerKeyPair {
  /** Ed25519 seed. Keep this value in memory/IndexedDB only; never log it. */
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export type { WireImage, ThinkingLevel, WireModel } from "@pi-reach/protocol/session";

export type RelayClientState = "idle" | "connecting" | "authenticating" | "open" | "closing" | "closed";
