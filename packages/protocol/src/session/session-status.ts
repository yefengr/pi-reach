import { z } from "zod";
import { positiveIntSchema, strictObject } from "./schema.js";

export const SESSION_STATUS_LEASE_MS = 30_000;
export const SESSION_STATUS_KEEPALIVE_MS = 10_000;
export const SESSION_STATUS_REQUEST_TIMEOUT_MS = 10_000;
export const SESSION_STATUS_BRANCH_CHARS = 256;
export const SESSION_STATUS_KEY_CHARS = 64;
export const SESSION_STATUS_LABEL_CHARS = 12;
export const SESSION_STATUS_TEXT_CHARS = 160;
export const SESSION_STATUS_MAX_EXTENSIONS = 12;

export const sessionStatusExtensionSchema = strictObject({
  key: z.string().min(1).max(SESSION_STATUS_KEY_CHARS),
  label: z.string().min(1).max(SESSION_STATUS_LABEL_CHARS),
  text: z.string().min(1).max(SESSION_STATUS_TEXT_CHARS),
  tone: z.enum(["warning", "error"]).optional(),
  section: z.enum(["context", "usage", "session"]).optional(),
});

const cacheHitRate = z.number().finite().min(0).max(100).nullable();
const sessionStatusContext = strictObject({
  tokens: positiveIntSchema.nullable(), window: positiveIntSchema.min(1), auto_compact: z.boolean(),
  level: z.enum(["normal", "high", "full"]).nullable(),
}).refine((context) => (context.tokens === null) === (context.level === null), { path: ["level"], message: "must be null if and only if tokens is null" });

export const sessionStatusSchema = strictObject({
  context: sessionStatusContext.nullable(),
  usage: strictObject({
    input: positiveIntSchema, output: positiveIntSchema, cache_read: positiveIntSchema, cache_write: positiveIntSchema,
    cost: z.number().finite().nonnegative(), cache_hit_rate_session: cacheHitRate, cache_hit_rate_latest: cacheHitRate,
  }),
  branch: z.string().min(1).max(SESSION_STATUS_BRANCH_CHARS).nullable(),
  extensions: z.array(sessionStatusExtensionSchema).max(SESSION_STATUS_MAX_EXTENSIONS),
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionStatusExtension = z.infer<typeof sessionStatusExtensionSchema>;
