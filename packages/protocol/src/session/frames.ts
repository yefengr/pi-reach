import { z } from "zod";
import {
  actionNameSchema,
  byeReasonSchema,
  channelIdSchema,
  harnessSchema,
  leafIdSchema,
  headSequenceSchema,
  idSchema,
  MAX_ARRAY_ITEMS,
  imageMimeSchema,
  pairingCodeSchema,
  protocolVersionSchema,
  eventSequenceSchema,
  sequencedTimelineEventSchema,
  timelineEventFragmentSchema,
  timelinePartialSchema,
  thinkingLevelSchema,
  queuedMessageItemSchema,
  timestampSchema,
  userBlockSchema,
  wireImageSchema,
  wireModelSchema,
  CLIENT_FRAME_TYPES,
  SERVER_FRAME_TYPES,
  strictObject,
  textSchema,
} from "./schema.js";
import {
  ATTACHMENT_CHUNK_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_IN_FLIGHT,
  ATTACHMENT_MAX_MESSAGE_BYTES,
  attachmentByteLengthSchema,
  attachmentChunkDataSchema,
  attachmentDescriptorSchema,
  attachmentFileNameSchema,
  attachmentIdsSchema,
  attachmentPreviewSchema,
  attachmentSha256Schema,
} from "./attachments.js";
import type { TimelineEvent, TimelinePartial } from "./schema.js";

const wireTimelineEventSchema: z.ZodType<TimelineEvent> = sequencedTimelineEventSchema;
const protocol = { protocol_version: protocolVersionSchema };
const channelRequest = { ...protocol, channel_id: channelIdSchema, session_id: idSchema, leaf_id: leafIdSchema };
const directResponse = { ...protocol, target_channel_id: channelIdSchema };
const ownerBroadcast = { ...protocol, session_id: idSchema, leaf_id: leafIdSchema };
const attachmentUploadRequest = { ...protocol, channel_id: channelIdSchema, session_id: idSchema, upload_scope: idSchema };
const attachmentUploadResponse = { ...directResponse, in_reply_to: idSchema, session_id: idSchema, upload_scope: idSchema };
const safeOffsetSchema = z.number().int().nonnegative().finite().max(Number.MAX_SAFE_INTEGER);

export const pairRequestFrameSchema = strictObject({ ...protocol, type: z.literal("pair_request"), id: idSchema, code: pairingCodeSchema, device_name: textSchema });
export const sessionHelloFrameSchema = strictObject({ ...protocol, type: z.literal("session_hello"), id: idSchema, channel_id: channelIdSchema });
export const extensionInfoRequestFrameSchema = strictObject({ ...protocol, type: z.literal("extension_info_request"), id: idSchema, ...channelRequest });
export const userMessageFrameSchema = strictObject({ ...protocol, type: z.literal("user_message"), id: idSchema, ...channelRequest, client_request_id: idSchema, text: textSchema, images: z.array(wireImageSchema).max(1).optional(), attachment_ids: attachmentIdsSchema.optional(), streaming_behavior: z.literal("steer").optional() }).superRefine((frame, ctx) => {
  if (frame.images !== undefined && frame.attachment_ids !== undefined) {
    ctx.addIssue({ code: "custom", path: ["attachment_ids"], message: "attachment_ids and images are mutually exclusive" });
  }
});
export const userMessageObservedFrameSchema = strictObject({ ...protocol, type: z.literal("user_message_observed"), id: idSchema, ...channelRequest, client_request_id: idSchema, message_id: idSchema, status: z.literal("committed") });
export const sessionSyncFrameSchema = strictObject({ ...protocol, type: z.literal("session_sync"), id: idSchema, ...channelRequest, before: eventSequenceSchema.nullable(), limit: z.number().int().min(1).finite().max(80).default(80) });
export const pingFrameSchema = strictObject({ ...protocol, type: z.literal("ping"), id: idSchema, ...channelRequest });
export const cancelFrameSchema = strictObject({ ...protocol, type: z.literal("cancel"), id: idSchema, ...channelRequest });
export const sessionNewFrameSchema = strictObject({ ...protocol, type: z.literal("session_new"), id: idSchema, ...channelRequest });
export const sessionCompactFrameSchema = strictObject({ ...protocol, type: z.literal("session_compact"), id: idSchema, ...channelRequest });
export const modelSetFrameSchema = strictObject({ ...protocol, type: z.literal("model_set"), id: idSchema, ...channelRequest, provider: idSchema, model_id: idSchema });
export const thinkingSetFrameSchema = strictObject({ ...protocol, type: z.literal("thinking_set"), id: idSchema, ...channelRequest, level: thinkingLevelSchema });
export const listModelsFrameSchema = strictObject({ ...protocol, type: z.literal("list_models"), id: idSchema, ...channelRequest });
export const queuedMessageSetFrameSchema = strictObject({ ...protocol, type: z.literal("queued_message_set"), id: idSchema, ...channelRequest, text: textSchema, images: z.array(wireImageSchema).max(1).optional() });
export const queuedMessageClearFrameSchema = strictObject({ ...protocol, type: z.literal("queued_message_clear"), id: idSchema, ...channelRequest, target_id: idSchema.optional() });
export const queuedMessageSteerFrameSchema = strictObject({ ...protocol, type: z.literal("queued_message_steer"), id: idSchema, ...channelRequest, target_id: idSchema });
export const approveToolFrameSchema = strictObject({ ...protocol, type: z.literal("approve_tool"), id: idSchema, ...channelRequest, tool_call_id: idSchema, decision: z.enum(["allow", "deny"]) });

export const attachmentCapabilitiesRequestFrameSchema = strictObject({ ...protocol, type: z.literal("attachment_capabilities_request"), id: idSchema, ...channelRequest });
export const attachmentBeginFrameSchema = strictObject({ ...protocol, type: z.literal("attachment_begin"), id: idSchema, ...attachmentUploadRequest, upload_id: idSchema, file_name: attachmentFileNameSchema, mime_type: imageMimeSchema, byte_length: attachmentByteLengthSchema, sha256: attachmentSha256Schema, preview: attachmentPreviewSchema.optional() });
export const attachmentChunkFrameSchema = strictObject({ ...protocol, type: z.literal("attachment_chunk"), id: idSchema, ...attachmentUploadRequest, upload_id: idSchema, offset: safeOffsetSchema, data_base64: attachmentChunkDataSchema });
export const attachmentFinishFrameSchema = strictObject({ ...protocol, type: z.literal("attachment_finish"), id: idSchema, ...attachmentUploadRequest, upload_id: idSchema });
export const attachmentStatusRequestFrameSchema = strictObject({ ...protocol, type: z.literal("attachment_status_request"), id: idSchema, ...attachmentUploadRequest, upload_id: idSchema });
export const attachmentCancelFrameSchema = strictObject({ ...protocol, type: z.literal("attachment_cancel"), id: idSchema, ...attachmentUploadRequest, upload_id: idSchema });

export const pairOkFrameSchema = strictObject({ ...protocol, type: z.literal("pair_ok"), in_reply_to: idSchema, session_name: textSchema, session_started_at: timestampSchema, endpoint_id: idSchema, harness: harnessSchema.optional(), hostname: textSchema.optional() });
export const pairErrorFrameSchema = strictObject({ ...protocol, type: z.literal("pair_error"), in_reply_to: idSchema, code: z.enum(["token_expired", "token_consumed", "token_unknown", "internal_error"]), message: textSchema.min(1) });
export const sessionReadyFrameSchema = strictObject({ ...directResponse, type: z.literal("session_ready"), in_reply_to: idSchema, session_id: idSchema, leaf_id: leafIdSchema, head_seq: headSequenceSchema, self_sender_ref: idSchema });
export const extensionInfoFrameSchema = strictObject({ ...directResponse, type: z.literal("extension_info"), in_reply_to: idSchema, version: idSchema });

const startedMessageSchema = strictObject({ id: idSchema, group_id: idSchema, blocks: z.array(userBlockSchema).max(MAX_ARRAY_ITEMS), origin: z.enum(["pwa", "extension", "unknown"]), sender_ref: idSchema.optional(), delivery: z.enum(["normal", "queued", "unknown"]) }).superRefine((message, ctx) => {
  if (message.origin === "pwa" && message.sender_ref === undefined) ctx.addIssue({ code: "custom", path: ["sender_ref"], message: "pwa user messages require sender_ref" });
  if (message.origin !== "pwa" && message.sender_ref !== undefined) ctx.addIssue({ code: "custom", path: ["sender_ref"], message: "non-pwa user messages must not include sender_ref" });
});
export const userMessageStartedFrameSchema = strictObject({ ...directResponse, type: z.literal("user_message_started"), in_reply_to: idSchema, session_id: idSchema, leaf_id: leafIdSchema, message: startedMessageSchema });

const userMessageStatusBase = { ...directResponse, type: z.literal("user_message_status"), in_reply_to: idSchema, session_id: idSchema, leaf_id: leafIdSchema, client_request_id: idSchema };
export const userMessageStatusFrameSchema = z.union([
  strictObject({ ...userMessageStatusBase, status: z.literal("received") }),
  strictObject({ ...userMessageStatusBase, status: z.literal("accepted"), message_id: idSchema.optional(), group_id: idSchema.optional() }),
  strictObject({ ...userMessageStatusBase, status: z.literal("committed"), message_id: idSchema, group_id: idSchema.optional() }),
  strictObject({ ...userMessageStatusBase, status: z.literal("unknown_delivery") }),
]);

export const timelineEventFrameSchema = strictObject({ ...ownerBroadcast, type: z.literal("timeline_event"), event: wireTimelineEventSchema });
export const timelinePartialFrameSchema = timelinePartialSchema;
export const timelineEventFragmentFrameSchema = strictObject({ ...ownerBroadcast, type: z.literal("timeline_event_fragment"), event_id: idSchema, index: z.number().int().nonnegative().finite(), data_base64: timelineEventFragmentSchema.shape.data_base64, final: z.boolean() });

const historyChunkBase = { ...directResponse, type: z.literal("session_history_chunk"), in_reply_to: idSchema, session_id: idSchema, leaf_id: leafIdSchema, chunk_index: z.number().int().nonnegative().finite(), events: z.array(wireTimelineEventSchema).max(MAX_ARRAY_ITEMS), fragments: z.array(timelineEventFragmentSchema).max(MAX_ARRAY_ITEMS) };
const historyChunkTail = { final_chunk: z.literal(false), next_before: z.never().optional(), eos: z.never().optional() };
const historyChunkEos = { final_chunk: z.literal(true), eos: z.literal(true), next_before: z.never().optional() };
const historyChunkNext = { final_chunk: z.literal(true), eos: z.literal(false), next_before: eventSequenceSchema };
function validateHistoryChunk(value: { events: Array<{ event_id: string }>; fragments: Array<{ event_id: string }> }, ctx: z.RefinementCtx): void {
  const eventIds = new Set(value.events.map((event) => event.event_id));
  const fragmentIds = new Set(value.fragments.map((fragment) => fragment.event_id));
  for (const eventId of eventIds) if (fragmentIds.has(eventId)) ctx.addIssue({ code: "custom", path: ["fragments"], message: "an event cannot be both complete and fragmented" });
  if (fragmentIds.size !== value.fragments.length) ctx.addIssue({ code: "custom", path: ["fragments"], message: "fragment event ids must be unique per chunk" });
}
export const sessionHistoryChunkFrameSchema = z.union([
  strictObject({ ...historyChunkBase, ...historyChunkTail }),
  strictObject({ ...historyChunkBase, ...historyChunkEos }),
  strictObject({ ...historyChunkBase, ...historyChunkNext }),
]).superRefine(validateHistoryChunk);

const protocolErrorFields = { type: z.literal("protocol_error"), in_reply_to: idSchema.optional(), code: z.enum(["protocol_upgrade_required", "invalid_message", "unsupported_type", "invalid_channel", "invalid_leaf", "invalid_cursor", "reset_required", "too_large", "internal_error"]), message: textSchema.min(1) };
export const protocolErrorFrameSchema = z.union([
  strictObject({ ...protocol, ...protocolErrorFields, target_channel_id: channelIdSchema }),
  strictObject({ ...protocol, ...protocolErrorFields }),
]);
export const resetFrameSchema = strictObject({ ...directResponse, type: z.literal("reset"), session_id: idSchema, leaf_id: leafIdSchema, reason: z.enum(["branch_changed", "session_replaced", "conflict", "invalid_cursor"]) });
export const pongFrameSchema = strictObject({ ...directResponse, type: z.literal("pong"), in_reply_to: idSchema });
export const cancelledFrameSchema = strictObject({ ...directResponse, type: z.literal("cancelled"), in_reply_to: idSchema });
export const actionOkFrameSchema = strictObject({ ...directResponse, type: z.literal("action_ok"), in_reply_to: idSchema, action: actionNameSchema });
export const actionErrorFrameSchema = strictObject({ ...directResponse, type: z.literal("action_error"), in_reply_to: idSchema, action: actionNameSchema, error: textSchema.min(1) });
export const modelsListFrameSchema = strictObject({ ...directResponse, type: z.literal("models_list"), in_reply_to: idSchema, models: z.array(wireModelSchema).max(MAX_ARRAY_ITEMS), current: wireModelSchema.optional() });
export const queuedMessageStateFrameSchema = strictObject({ ...ownerBroadcast, type: z.literal("queued_message_state"), snapshot_id: idSchema, chunk_index: z.number().int().nonnegative().finite(), final: z.boolean(), items: z.array(queuedMessageItemSchema).max(MAX_ARRAY_ITEMS) });
export const byeFrameSchema = strictObject({ ...ownerBroadcast, type: z.literal("bye"), reason: byeReasonSchema });

export const attachmentCapabilitiesFrameSchema = strictObject({ ...attachmentUploadResponse, type: z.literal("attachment_capabilities"), max_file_bytes: z.literal(ATTACHMENT_MAX_FILE_BYTES), max_message_bytes: z.literal(ATTACHMENT_MAX_MESSAGE_BYTES), max_attachments: z.literal(ATTACHMENT_MAX_COUNT), chunk_bytes: z.literal(ATTACHMENT_CHUNK_BYTES), max_in_flight: z.literal(ATTACHMENT_MAX_IN_FLIGHT) });

const attachmentStateBase = { ...attachmentUploadResponse, type: z.literal("attachment_state"), upload_id: idSchema, received_bytes: z.number().int().nonnegative().finite().max(ATTACHMENT_MAX_FILE_BYTES) };
export const attachmentStateFrameSchema = z.union([
  strictObject({ ...attachmentStateBase, status: z.literal("receiving") }),
  strictObject({ ...attachmentStateBase, status: z.literal("cancelled") }),
  strictObject({ ...attachmentStateBase, status: z.literal("complete"), attachment: attachmentDescriptorSchema }).superRefine((state, ctx) => {
    if (state.received_bytes !== state.attachment.byte_length) {
      ctx.addIssue({ code: "custom", path: ["received_bytes"], message: "received_bytes must equal attachment.byte_length" });
    }
  }),
]);

export const attachmentErrorCodeSchema = z.enum(["invalid_scope", "not_found", "invalid_upload", "too_large", "busy", "no_space", "io_error", "integrity_mismatch", "offset_mismatch", "cancelled"]);
export const attachmentErrorFrameSchema = strictObject({ ...attachmentUploadResponse, type: z.literal("attachment_error"), upload_id: idSchema.optional(), code: attachmentErrorCodeSchema, retryable: z.boolean() });

export const clientFrameSchema = z.union([pairRequestFrameSchema, sessionHelloFrameSchema, extensionInfoRequestFrameSchema, userMessageFrameSchema, userMessageObservedFrameSchema, sessionSyncFrameSchema, pingFrameSchema, cancelFrameSchema, sessionNewFrameSchema, sessionCompactFrameSchema, modelSetFrameSchema, thinkingSetFrameSchema, listModelsFrameSchema, queuedMessageSetFrameSchema, queuedMessageClearFrameSchema, queuedMessageSteerFrameSchema, approveToolFrameSchema, attachmentCapabilitiesRequestFrameSchema, attachmentBeginFrameSchema, attachmentChunkFrameSchema, attachmentFinishFrameSchema, attachmentStatusRequestFrameSchema, attachmentCancelFrameSchema]);
export const serverFrameSchema = z.union([pairOkFrameSchema, pairErrorFrameSchema, sessionReadyFrameSchema, extensionInfoFrameSchema, userMessageStartedFrameSchema, userMessageStatusFrameSchema, timelineEventFrameSchema, timelinePartialFrameSchema, timelineEventFragmentFrameSchema, sessionHistoryChunkFrameSchema, protocolErrorFrameSchema, resetFrameSchema, pongFrameSchema, cancelledFrameSchema, actionOkFrameSchema, actionErrorFrameSchema, modelsListFrameSchema, queuedMessageStateFrameSchema, byeFrameSchema, attachmentCapabilitiesFrameSchema, attachmentStateFrameSchema, attachmentErrorFrameSchema]);

export const ClientFrameSchema = clientFrameSchema;
export const ServerFrameSchema = serverFrameSchema;
export const SessionHistoryChunkSchema = sessionHistoryChunkFrameSchema;
export type ClientFrame = z.input<typeof clientFrameSchema>;
export type ServerFrame = z.infer<typeof serverFrameSchema>;
export type DirectClientFrame = Exclude<ClientFrame, { type: "pair_request" | "ping" }>;
export type OwnerBroadcastServerFrame = Extract<ServerFrame, { type: "timeline_event" | "timeline_partial" | "timeline_event_fragment" | "queued_message_state" | "bye" }>;
export const clientFrameTypes = new Set<string>(CLIENT_FRAME_TYPES);
export const serverFrameTypes = new Set<string>(SERVER_FRAME_TYPES);
export const ClientFrameTypes = clientFrameTypes;
export const ServerFrameTypes = serverFrameTypes;
export type { TimelineEvent, TimelinePartial };
