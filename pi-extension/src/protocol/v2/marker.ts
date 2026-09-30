import { z } from "zod";
import {
  DecodeError,
  idSchema,
  MAX_FRAGMENT_DECODE_BYTES,
  parseProtocolJsonV2,
  validateEncodedSizeV2,
} from "@pi-reach/protocol/session";

export const TIMELINE_MARKER_NAME = "pi-reach:timeline-v2" as const;

const markerSystemKind = z.enum(["compaction", "branch_summary", "custom"]);
const markerGroupedBase = { version: z.literal(2), group_id: idSchema };
const markerUser = z.strictObject({
  ...markerGroupedBase,
  kind: z.literal("user"),
  origin: z.enum(["pwa", "extension", "unknown"]),
  delivery: z.enum(["normal", "queued", "unknown"]),
  sender_ref: idSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.origin === "pwa" && value.sender_ref === undefined) {
    ctx.addIssue({ code: "custom", path: ["sender_ref"], message: "pwa marker users require sender_ref" });
  }
  if (value.origin !== "pwa" && value.sender_ref !== undefined) {
    ctx.addIssue({ code: "custom", path: ["sender_ref"], message: "non-pwa marker users must not include sender_ref" });
  }
});
const markerGrouped = z.strictObject({
  ...markerGroupedBase,
  kind: z.enum(["assistant", "tool", "provider_error"]),
});
const markerRunEnd = z.strictObject({
  ...markerGroupedBase,
  kind: z.literal("run_end"),
  status: z.enum(["complete", "interrupted", "error"]),
});
const markerSystem = z.strictObject({
  version: z.literal(2),
  kind: markerSystemKind,
  group_id: idSchema.optional(),
});

export const MarkerSchemaV2 = z.union([markerUser, markerGrouped, markerRunEnd, markerSystem]);
export type MarkerV2 = z.infer<typeof MarkerSchemaV2>;

function schemaMessage(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
}

export function parseMarkerV2(raw: unknown): MarkerV2 {
  const value = parseProtocolJsonV2(raw);
  const result = MarkerSchemaV2.safeParse(value);
  if (!result.success) {
    throw new DecodeError("schema", schemaMessage(result.error), { cause: result.error });
  }
  validateEncodedSizeV2(result.data, MAX_FRAGMENT_DECODE_BYTES);
  return result.data;
}
