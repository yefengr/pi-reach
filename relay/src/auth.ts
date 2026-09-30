import { createPublicKey, randomBytes, verify } from "node:crypto";

import { canonicalPublicKey, parseJsonObject, WireError } from "./wire.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type Challenge = { nonce: Buffer; line: string };

export function createChallenge(): Challenge {
  const nonce = randomBytes(32);
  return { nonce, line: JSON.stringify({ type: "challenge", nonce: nonce.toString("base64") }) };
}

export function verifyAuth(publicKey: string, nonce: Buffer, text: string): boolean {
  try {
    const value = parseJsonObject(text);
    if (Object.keys(value).length !== 2 || value.type !== "auth" || typeof value.sig !== "string") return false;
    if (!/^[A-Za-z0-9+/]{86}==$/.test(value.sig)) return false;
    const signature = Buffer.from(value.sig, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== value.sig) return false;
    const canonical = canonicalPublicKey(publicKey);
    const raw = Buffer.from(canonical, "base64");
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, nonce, key, signature);
  } catch (error) {
    if (error instanceof WireError || error instanceof SyntaxError) return false;
    return false;
  }
}
