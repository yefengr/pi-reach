import { z } from "zod";
import { PROTOCOL_VERSION } from "../constants.js";

export { PROTOCOL_VERSION } from "../constants.js";
export const PROTOCOL_VERSION_V2 = PROTOCOL_VERSION;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_HISTORY_CHUNK_BYTES = 512 * 1024;
export const MAX_SESSION_HISTORY_CHUNK_BYTES = MAX_HISTORY_CHUNK_BYTES;
export const MAX_WINDOW_BYTES = 32 * 1024 * 1024;
export const MAX_WINDOW_DECODE_BYTES = MAX_WINDOW_BYTES;
export const MAX_FRAGMENT_BYTES = 50 * 1024;
export const MAX_FRAGMENT_DECODE_BYTES = MAX_FRAGMENT_BYTES;
export const MAX_ID_CHARS = 256;
export const MAX_STRING_CHARS = 1024 * 1024;
export const MAX_TEXT_CHARS = MAX_STRING_CHARS;
export const MAX_ARRAY_ITEMS = 4096;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const finiteNumber = z.number().finite();
export const idSchema = z.string().min(1).max(MAX_ID_CHARS);
export const pairingCodeSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/);
export const textSchema = z.string().max(MAX_STRING_CHARS);
export const nonEmptyTextSchema = textSchema.min(1);
export const timestampSchema = finiteNumber.nonnegative();
export const positiveIntSchema = z.number().int().nonnegative().finite();
/** Dense history ordinals are positive and exactly representable in JavaScript. */
export const eventSequenceSchema = z.number().int().positive().finite().max(Number.MAX_SAFE_INTEGER);
export const headSequenceSchema = z.number().int().nonnegative().finite().max(Number.MAX_SAFE_INTEGER - 1);
export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);
export const channelIdSchema = idSchema;
export const leafIdSchema = idSchema.nullable();

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    finiteNumber,
    textSchema,
    z.array(jsonValueSchema).max(MAX_ARRAY_ITEMS),
    z.record(z.string().max(MAX_ID_CHARS), jsonValueSchema),
  ]),
);
export const JsonValueSchema = jsonValueSchema;

const truncatedSchema = z.literal(true);
const textBlockShape = {
  type: z.literal("text"),
  text: textSchema,
  truncated: truncatedSchema.optional(),
};
export const textBlockSchema = strictObject(textBlockShape);

const thinkingBlockShape = {
  type: z.literal("thinking"),
  text: textSchema,
  truncated: truncatedSchema.optional(),
};
export const thinkingBlockSchema = strictObject(thinkingBlockShape);

export const imageMimeSchema = z.string().min(1).max(128).regex(/^[\w.+-]+\/[\w.+-]+$/);
const imageByteLengthSchema = positiveIntSchema.max(MAX_WINDOW_BYTES);
const completeImageSchema = strictObject({
  type: z.literal("image"),
  mime_type: imageMimeSchema,
  data: z.string().min(1).max(MAX_WINDOW_BYTES),
  byte_length: imageByteLengthSchema,
});
const omittedImageSchema = strictObject({
  type: z.literal("image"),
  mime_type: imageMimeSchema,
  byte_length: imageByteLengthSchema,
  omitted: z.literal(true),
});
export const imageBlockSchema = z.union([completeImageSchema, omittedImageSchema]);
export const userBlockSchema = z.union([textBlockSchema, imageBlockSchema]);
export const assistantBlockSchema = z.union([textBlockSchema, thinkingBlockSchema]);

const timelineBaseShape = {
  event_id: idSchema,
  // Legacy IndexedDB records predate dense history ordinals.
  event_seq: eventSequenceSchema.optional(),
  session_id: idSchema,
  leaf_id: leafIdSchema,
  timestamp: timestampSchema,
};
const groupedTimelineBaseShape = {
  ...timelineBaseShape,
  group_id: idSchema,
};

const userEventShape = {
  ...groupedTimelineBaseShape,
  kind: z.literal("user"),
  message_id: idSchema,
  blocks: z.array(userBlockSchema).max(MAX_ARRAY_ITEMS),
  origin: z.enum(["pwa", "extension", "unknown"]),
  sender_ref: idSchema.optional(),
  delivery: z.enum(["normal", "queued", "unknown"]),
  status: z.literal("committed"),
};
export const timelineUserEventSchema = strictObject(userEventShape).superRefine((event, ctx) => {
  if (event.event_id !== event.message_id) {
    ctx.addIssue({ code: "custom", path: ["message_id"], message: "event_id must equal message_id" });
  }
  if (event.origin === "pwa" && event.sender_ref === undefined) {
    ctx.addIssue({ code: "custom", path: ["sender_ref"], message: "pwa user events require sender_ref" });
  }
  if (event.origin !== "pwa" && event.sender_ref !== undefined) {
    ctx.addIssue({ code: "custom", path: ["sender_ref"], message: "non-pwa user events must not include sender_ref" });
  }
});

const assistantEventShape = {
  ...groupedTimelineBaseShape,
  kind: z.literal("assistant"),
  blocks: z.array(assistantBlockSchema).max(MAX_ARRAY_ITEMS),
  status: z.enum(["complete", "interrupted"]),
};
export const timelineAssistantEventSchema = strictObject(assistantEventShape);

const completeToolEventSchema = strictObject({
  ...groupedTimelineBaseShape,
  kind: z.literal("tool"),
  tool_call_id: idSchema,
  tool: nonEmptyTextSchema,
  args: jsonValueSchema,
  truncated: z.boolean(),
  status: z.literal("complete"),
  result: jsonValueSchema,
  error: z.never().optional(),
});
const errorToolEventSchema = strictObject({
  ...groupedTimelineBaseShape,
  kind: z.literal("tool"),
  tool_call_id: idSchema,
  tool: nonEmptyTextSchema,
  args: jsonValueSchema,
  truncated: z.boolean(),
  status: z.literal("error"),
  result: jsonValueSchema.optional(),
  error: nonEmptyTextSchema,
});
const interruptedToolEventSchema = strictObject({
  ...groupedTimelineBaseShape,
  kind: z.literal("tool"),
  tool_call_id: idSchema,
  tool: nonEmptyTextSchema,
  args: jsonValueSchema,
  truncated: z.boolean(),
  status: z.literal("interrupted"),
  result: z.never().optional(),
  error: z.never().optional(),
});
export const timelineToolEventSchema = z.union([
  completeToolEventSchema,
  errorToolEventSchema,
  interruptedToolEventSchema,
]);

const groupedSystemShape = {
  ...timelineBaseShape,
  kind: z.enum(["compaction", "branch_summary", "custom"]),
  group_id: idSchema.optional(),
  payload: jsonValueSchema,
  truncated: z.boolean(),
};
export const timelineSystemEventSchema = strictObject(groupedSystemShape);
export const timelineProviderErrorEventSchema = strictObject({
  ...groupedTimelineBaseShape,
  kind: z.literal("provider_error"),
  message: nonEmptyTextSchema,
});

/** One Pi run (agent_start → agent_end) has finished; the group it closes is `group_id`. */
export const timelineRunEndEventSchema = strictObject({
  ...groupedTimelineBaseShape,
  kind: z.literal("run_end"),
  status: z.enum(["complete", "interrupted", "error"]),
});

export const timelineEventSchema = z.union([
  timelineUserEventSchema,
  timelineAssistantEventSchema,
  timelineToolEventSchema,
  timelineSystemEventSchema,
  timelineProviderErrorEventSchema,
  timelineRunEndEventSchema,
]);
export const TimelineEventSchema = timelineEventSchema;
export const sequencedTimelineEventSchema = timelineEventSchema.and(
  z.object({ event_seq: eventSequenceSchema }),
);
export type TimelineEvent = z.infer<typeof timelineEventSchema>;
export type SequencedTimelineEvent = z.infer<typeof sequencedTimelineEventSchema>;
export type TimelineUserEvent = z.infer<typeof timelineUserEventSchema>;
export type TimelineRunEndEvent = z.infer<typeof timelineRunEndEventSchema>;

const partialBaseShape = {
  protocol_version: protocolVersionSchema,
  type: z.literal("timeline_partial"),
  session_id: idSchema,
  leaf_id: leafIdSchema,
  group_id: idSchema,
  partial_id: idSchema,
  status: z.enum(["running", "delta"]),
};
const partialTextShape = { delta: textSchema.optional() };
export const timelinePartialSchema = z.union([
  strictObject({
    ...partialBaseShape,
    kind: z.literal("assistant"),
    blocks: z.array(assistantBlockSchema).max(MAX_ARRAY_ITEMS).optional(),
    ...partialTextShape,
  }),
  strictObject({
    ...partialBaseShape,
    kind: z.literal("thinking"),
    blocks: z.array(thinkingBlockSchema).max(MAX_ARRAY_ITEMS).optional(),
    ...partialTextShape,
  }),
  strictObject({
    ...partialBaseShape,
    kind: z.literal("tool"),
    tool_call_id: idSchema,
    tool: nonEmptyTextSchema,
    args: jsonValueSchema.optional(),
    blocks: z.array(assistantBlockSchema).max(MAX_ARRAY_ITEMS).optional(),
    ...partialTextShape,
  }),
]);
export const TimelinePartialSchema = timelinePartialSchema;
export type TimelinePartial = z.infer<typeof timelinePartialSchema>;

export const base64Schema = z.string()
  .min(4)
  .max(Math.ceil((MAX_FRAGMENT_BYTES * 4) / 3) + 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const timelineEventFragmentSchema = strictObject({
  event_id: idSchema,
  index: positiveIntSchema,
  data_base64: base64Schema,
  final: z.boolean(),
});
export type TimelineEventFragment = z.infer<typeof timelineEventFragmentSchema>;
export const historyFragmentSchema = timelineEventFragmentSchema;
export const TimelineEventFragmentSchema = timelineEventFragmentSchema;
export const HistoryFragmentSchema = historyFragmentSchema;


export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export const actionNameSchema = z.enum(["session_new", "session_compact", "model_set", "thinking_set"]);
export const byeReasonSchema = z.enum(["peer_stop", "session_replaced", "shutdown"]);
export const wireImageSchema = strictObject({
  data: z.string().min(1).max(MAX_WINDOW_BYTES),
  mime: imageMimeSchema,
});
export type WireImage = z.infer<typeof wireImageSchema>;
export const queuedMessageItemSchema = strictObject({
  id: idSchema,
  text: textSchema,
  images: z.array(wireImageSchema).max(1).optional(),
  sender_ref: idSchema.optional(),
  editable: z.boolean(),
  created_at: timestampSchema,
});
export const wireModelSchema = strictObject({
  id: idSchema,
  name: textSchema,
  provider: idSchema,
  reasoning: z.boolean(),
  context_window: positiveIntSchema,
  vision: z.boolean(),
});
export type WireModel = z.infer<typeof wireModelSchema>;
export const harnessSchema = strictObject({ name: idSchema, version: idSchema });

export const CLIENT_FRAME_TYPES = [
  "pair_request", "session_hello", "user_message", "user_message_observed", "session_sync", "ping", "cancel",
  "session_new", "session_compact", "model_set", "thinking_set", "list_models", "queued_message_set",
  "queued_message_clear", "queued_message_steer", "approve_tool", "extension_info_request",
] as const;
export const SERVER_FRAME_TYPES = [
  "pair_ok", "pair_error", "session_ready", "user_message_started", "user_message_status", "timeline_event",
  "timeline_partial", "timeline_event_fragment", "session_history_chunk", "protocol_error", "reset", "pong",
  "cancelled", "action_ok", "action_error", "models_list", "queued_message_state", "bye",
  "extension_info",
] as const;
export type ClientFrameType = (typeof CLIENT_FRAME_TYPES)[number];
export type ServerFrameType = (typeof SERVER_FRAME_TYPES)[number];
