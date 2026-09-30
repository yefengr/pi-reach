import type { JsonValue } from "@pi-reach/protocol/session";

export {
  DECODE_ERROR_CODES,
  DecodeError,
  decodeClientFrameV2,
  decodeServerFrameV2,
  encodeClientFrameTextV2 as encodeClientFrameV2,
  encodeServerFrameTextV2 as encodeServerFrameV2,
  getUtf8ByteLengthV2,
  parseProtocolJsonV2,
  parseTimelineEventV2,
  parseTimelinePartialV2,
  validateEncodedSizeV2,
  validateFragmentSizeV2,
  validateHistoryChunkSizeV2,
  validateSessionHistoryChunkSize,
  validateSessionHistoryChunkV2,
  validateTimelineEventFragmentV2,
  validateTimelineWindowV2,
  validateWindowSizeV2,
} from "@pi-reach/protocol/session";
export type { DecodeErrorCode } from "@pi-reach/protocol/session";
export {
  HistoryFragmentSchema,
  SessionHistoryChunkSchema,
  TimelineEventFragmentSchema,
} from "./schemas.js";
export { parseMarkerV2 } from "./marker.js";

export type JsonValueV2 = JsonValue;
