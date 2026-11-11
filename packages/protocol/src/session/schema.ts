import { z } from "zod";
import { PROTOCOL_VERSION } from "../constants.js";
import { boundedJsonByteLength } from "./json-budget.js";

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
export const TOOL_DETAILS_CAPABILITY = 1;
/** `session_sync.limit` 的上限；旧 Extension 只接受 80，超出时以 `protocol_upgrade_required` 拒绝。 */
export const MAX_SESSION_SYNC_LIMIT = 160;
/** 旧 Extension 接受的 `session_sync.limit` 上限，也是省略 `limit` 时的默认值。 */
export const LEGACY_SESSION_SYNC_LIMIT = 80;
export const MAX_TOOL_SUMMARY_BYTES = 4096;
export const MAX_TOOL_PREVIEW_BYTES = 64 * 1024;
export const MAX_TOOL_PREVIEWS_BYTES = 512 * 1024;
export const MAX_TOOL_PREVIEWS = 8;
export const MAX_TOOL_DETAIL_SUBSCRIPTIONS = 16;
export const TOOL_DETAIL_LEASE_MS = 30_000;
export const TOOL_DETAIL_KEEPALIVE_MS = 10_000;
export const MAX_TOOL_DETAILS_BYTES = 8 * 1024 * 1024;
export const MAX_TOOL_DETAILS_QUEUE_BYTES = 16 * 1024 * 1024;
export const MAX_TOOL_DETAILS_CACHE_BYTES = 16 * 1024 * 1024;
export const MAX_TOOL_DETAILS_CACHE_ENTRIES = 64;

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

export const toolRefSchema = strictObject({ call_entry_id: idSchema, tool_call_id: idSchema });
export type ToolRef = z.infer<typeof toolRefSchema>;

export const toolSummarySchema = strictObject({
  action: z.enum(["read", "write", "edit", "execute", "search", "other"]),
  command: z.string().max(512).optional(),
  path: z.string().max(512).optional(),
  query: z.string().max(512).optional(),
  offset: positiveIntSchema.optional(),
  limit: positiveIntSchema.optional(),
}).refine((value) => boundedJsonByteLength(value, MAX_TOOL_SUMMARY_BYTES) !== null, "tool summary exceeds byte budget");
export type ToolSummary = z.infer<typeof toolSummarySchema>;

const summaryToolFields = {
  tool_call_id: idSchema,
  tool: idSchema,
  representation: z.literal("summary"),
  summary: toolSummarySchema,
  tool_ref: toolRefSchema,
};
function matchingToolRef(value: { tool_call_id: string; tool_ref: ToolRef }, ctx: z.RefinementCtx): void {
  if (value.tool_call_id !== value.tool_ref.tool_call_id) {
    ctx.addIssue({ code: "custom", path: ["tool_ref", "tool_call_id"], message: "tool reference must match the call" });
  }
}
export const timelineSummaryToolEventSchema = strictObject({
  ...groupedTimelineBaseShape,
  kind: z.literal("tool"),
  ...summaryToolFields,
  status: z.enum(["complete", "error", "interrupted"]),
}).superRefine(matchingToolRef);

// 详情允许保存的较长字符串；整个文档先过预算门禁，再进入递归 schema。
const toolDetailsJsonSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), finiteNumber, z.string().max(MAX_TOOL_DETAILS_BYTES),
  z.array(toolDetailsJsonSchema).max(MAX_ARRAY_ITEMS),
  z.record(z.string().max(MAX_ID_CHARS), toolDetailsJsonSchema),
]));
export const toolDetailsContentSchema = z.unknown().superRefine((value, ctx) => {
  if (boundedJsonByteLength(value, MAX_TOOL_DETAILS_BYTES) === null) {
    ctx.addIssue({ code: "custom", message: "tool details exceed JSON budget" });
  }
}).pipe(strictObject({
  tool_ref: toolRefSchema,
  tool: idSchema,
  source: z.enum(["preview", "session"]),
  status: z.enum(["preparing", "running", "complete", "error", "interrupted"]),
  args: toolDetailsJsonSchema,
  result: toolDetailsJsonSchema.optional(),
  error: z.string().max(MAX_TOOL_DETAILS_BYTES).optional(),
  limited: z.boolean(),
}).superRefine((value, ctx) => {
  const active = value.status === "preparing" || value.status === "running";
  if ((value.source === "preview") !== active) ctx.addIssue({ code: "custom", path: ["source"], message: "source must match lifecycle phase" });
  if (value.source === "session" && value.limited) ctx.addIssue({ code: "custom", path: ["limited"], message: "limited content is a preview, not a final result" });
  if (value.source === "session" && value.status === "complete" && value.result === undefined) {
    ctx.addIssue({ code: "custom", path: ["result"], message: "complete details require the saved result" });
  }
}));
export type ToolDetailsContent = z.infer<typeof toolDetailsContentSchema>;

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
  timelineSummaryToolEventSchema,
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
    ...summaryToolFields,
    target_channel_id: channelIdSchema.optional(),
    status: z.enum(["preparing", "running", "delta"]),
    kind: z.literal("tool"),
  }).superRefine(matchingToolRef),
  strictObject({
    ...partialBaseShape,
    // preparing：模型仍在生成该调用（参数可能不完整），尚未开始执行；只有工具 partial 使用。
    status: z.enum(["preparing", "running", "delta"]),
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


export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
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
  "pair_request", "session_hello", "user_message", "user_message_status_request", "user_message_observed", "session_sync", "ping", "cancel",
  "session_new", "session_compact", "model_set", "thinking_set", "list_models", "queued_message_set",
  "queued_message_clear", "queued_message_steer", "approve_tool", "extension_info_request",
  "attachment_capabilities_request", "attachment_begin", "attachment_chunk", "attachment_finish", "attachment_status_request", "attachment_cancel", "attachment_discard",
  "file_open", "file_attachment_open", "file_read", "file_close",
  "tool_details_open", "tool_details_close",
] as const;
export const SERVER_FRAME_TYPES = [
  "pair_ok", "pair_error", "session_ready", "user_message_started", "user_message_status", "timeline_event",
  "timeline_partial", "timeline_event_fragment", "session_history_chunk", "protocol_error", "reset", "pong",
  "cancelled", "action_ok", "action_error", "compaction_activity", "models_list", "queued_message_state", "bye",
  "extension_info",
  "attachment_capabilities", "attachment_state", "attachment_error", "attachment_discarded",
  "file_opened", "file_chunk", "file_closed", "file_error",
  "tool_details_chunk", "tool_details_error",
] as const;
export type ClientFrameType = (typeof CLIENT_FRAME_TYPES)[number];
export type ServerFrameType = (typeof SERVER_FRAME_TYPES)[number];
