import type { PROTOCOL_VERSION } from "../constants.js";

export type EndpointMetadata = {
  kind: "daemon" | "interactive";
  name?: string | null;
  cwd?: string | null;
  pid?: number | null;
  started_at?: number | null;
  model?: string | null;
  thinking?: string | null;
  working?: boolean | null;
};

export type EndpointInfo = {
  endpoint_id: string;
  runtime_instance_id: string;
  metadata: EndpointMetadata;
};

export type RoutePurpose = "pairing" | "session";
export type RouteFrame = {
  type: "route";
  purpose: RoutePurpose;
  device_id: string;
  endpoint_id: string;
  runtime_instance_id: string;
  target_owner_id?: string;
  source_owner_id?: string;
  ct: string;
};

export type OwnerHelloFrame = { type: "hello"; protocol_version: typeof PROTOCOL_VERSION; role: "owner"; pubkey: string };
export type HostHelloFrame = {
  type: "hello";
  protocol_version: typeof PROTOCOL_VERSION;
  role: "host";
  pubkey: string;
  endpoint_id: string;
  runtime_instance_id: string;
  metadata: EndpointMetadata;
  authorized_owner_ids: readonly string[];
};
export type HelloFrame = OwnerHelloFrame | HostHelloFrame;
export type ChallengeFrame = { type: "challenge"; nonce: string };
export type AuthFrame = { type: "auth"; sig: string };
export type EndpointUpdateFrame = { type: "endpoint_update"; metadata?: EndpointMetadata; authorized_owner_ids?: readonly string[] };
export type PairingOfferFrame = { type: "pairing_offer"; code: string; endpoint_id: string; runtime_instance_id: string; expires_at: number };
export type HostControlOutbound = EndpointUpdateFrame | PairingOfferFrame;

export type PairingTargetControl = { type: "pairing_target"; in_reply_to: string; code: string; device_id: string; endpoint_id: string; runtime_instance_id: string };
export type PairingCodeErrorReason = "unknown_code" | "expired_code" | "stale_target" | "rate_limited";
export type PairingCodeErrorControl = { type: "pairing_code_error"; in_reply_to: string; reason: PairingCodeErrorReason };
export type EndpointsControl = { type: "endpoints"; device_id: string; endpoints: EndpointInfo[] };
export type EndpointAnnouncedControl = { type: "endpoint_announced"; device_id: string; endpoint_id: string; runtime_instance_id: string; metadata: EndpointMetadata };
export type EndpointUpdatedControl = { type: "endpoint_updated"; device_id: string; endpoint_id: string; runtime_instance_id: string; metadata: EndpointMetadata };
export type EndpointEndedControl = { type: "endpoint_ended"; device_id: string; endpoint_id: string; runtime_instance_id: string };
export type ControlFrame = PairingTargetControl | PairingCodeErrorControl | EndpointsControl | EndpointAnnouncedControl | EndpointUpdatedControl | EndpointEndedControl;
export type ControlOutbound = { type: "resolve_pairing_code"; request_id: string; code: string } | { type: "subscribe_endpoints"; device_ids: string[] };
export type RelayFrame = { kind: "route"; route: RouteFrame } | { kind: "control"; frame: ControlFrame };
