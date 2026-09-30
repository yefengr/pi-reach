import { normalizeDeviceId } from "./encoding";
import type { ClientFrame } from "./protocol-v2/frames";

const PAIR_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** Removes display separators and returns the canonical Crockford Base32 code. */
export function normalizePairCode(raw: string): string | undefined {
  const normalized = raw.replace(/[\s-]/g, "").toUpperCase();
  return PAIR_CODE_PATTERN.test(normalized) ? normalized : undefined;
}

export function createPairRequest(code: string, deviceName: string, id: string): Extract<ClientFrame, { type: "pair_request" }> {
  if (!code || !deviceName || !id) throw new Error("Pair request requires code, device name, and id");
  return { protocol_version: 2, type: "pair_request", id, code, device_name: deviceName };
}

export function normalizePairDeviceId(deviceId: string): string {
  return normalizeDeviceId(deviceId);
}
