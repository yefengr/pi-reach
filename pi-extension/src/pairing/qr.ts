import { randomBytes } from "node:crypto";
import { PAIRING_INVITE_TTL_MS, PAIR_TTL_MAX_MS, PAIR_TTL_MIN_MS } from "@pi-reach/protocol/outer";
import qrTerminal from "qrcode-terminal";

export { PAIRING_INVITE_TTL_MS, PAIR_TTL_MAX_MS, PAIR_TTL_MIN_MS };
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function clampPairTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return PAIRING_INVITE_TTL_MS;
  return Math.min(PAIR_TTL_MAX_MS, Math.max(PAIR_TTL_MIN_MS, Math.floor(ttlMs)));
}

export type PairingInvite = Readonly<{
  code: string;
  expiresAt: number;
}>;

export type CodeReservation = Readonly<{
  code: string;
  ownerId: string;
  requestId: string;
}>;

type ReservationState = {
  reservation: CodeReservation;
  status: "reserved" | "released" | "committed";
  completion?: unknown;
};

export type CodeReservationResult<T = unknown> =
  | { status: "reserved"; reservation: CodeReservation }
  | { status: "committed"; completion: T }
  | { status: "expired" | "consumed" | "unknown" };

interface ActiveInvite extends PairingInvite {
  consumed: boolean;
  reservation?: ReservationState;
}

export class QRSession {
  private active: ActiveInvite | null = null;

  generateCode(): string {
    const random = randomBytes(PAIRING_CODE_LENGTH);
    let code = "";
    for (const byte of random) code += CROCKFORD_BASE32[byte & 31];
    return code;
  }

  issueCode(ttlMs: number = PAIRING_INVITE_TTL_MS): PairingInvite {
    const invite = Object.freeze({ code: this.generateCode(), expiresAt: Date.now() + ttlMs });
    this.active = { ...invite, consumed: false };
    return invite;
  }

  issueInvite(ttlMs: number = PAIRING_INVITE_TTL_MS): PairingInvite {
    return this.issueCode(ttlMs);
  }

  getActiveInvite(): PairingInvite | null {
    if (!this.active) return null;
    return { code: this.active.code, expiresAt: this.active.expiresAt };
  }

  reserveCode<T = unknown>(code: string, ownerId: string, requestId: string): CodeReservationResult<T> {
    const active = this.active;
    if (!active || active.code !== code) return { status: "unknown" };

    const existing = active.reservation;
    if (existing) {
      if (existing.reservation.ownerId !== ownerId || existing.reservation.requestId !== requestId) {
        return { status: "consumed" };
      }
      // A committed result belongs to the exact Owner/request and remains
      // replayable until this invite is replaced or cleared, even after its TTL.
      if (existing.status === "committed") {
        return { status: "committed", completion: existing.completion as T };
      }
    }
    if (Date.now() >= active.expiresAt) return { status: "expired" };
    if (active.consumed) return { status: "consumed" };

    if (existing) {
      if (existing.status === "reserved") return { status: "reserved", reservation: existing.reservation };
      // A released reservation remains private to the original attempt. A
      // retry by that exact Owner/request may reacquire it; nobody else can.
    }

    const reservation = existing?.status === "released"
      ? Object.freeze({ code, ownerId, requestId })
      : existing?.reservation ?? Object.freeze({ code, ownerId, requestId });
    active.reservation = { reservation, status: "reserved" };
    return { status: "reserved", reservation };
  }

  commitCode<T>(reservation: CodeReservation, completion: T): boolean {
    const active = this.active;
    const state = active?.reservation;
    if (!active || !state || state.reservation !== reservation || state.status !== "reserved") return false;
    if (active.code !== reservation.code || Date.now() >= active.expiresAt) return false;
    state.status = "committed";
    state.completion = completion;
    return true;
  }

  releaseCode(reservation: CodeReservation): boolean {
    const active = this.active;
    const state = active?.reservation;
    if (!active || !state || state.reservation !== reservation || state.status !== "reserved") return false;
    state.status = "released";
    return true;
  }

  isReservationCurrent(reservation: CodeReservation): boolean {
    const active = this.active;
    const state = active?.reservation;
    return !!active && !!state && state.reservation === reservation && state.status === "reserved" && active.code === reservation.code && Date.now() < active.expiresAt;
  }

  consumeCode(code: string): "ok" | "expired" | "consumed" | "unknown" {
    if (!this.active || this.active.code !== code) return "unknown";
    if (this.active.consumed || this.active.reservation) return "consumed";
    if (Date.now() >= this.active.expiresAt) return "expired";
    this.active.consumed = true;
    return "ok";
  }

  clear(): void {
    this.active = null;
  }
}

export const qrSession = new QRSession();

export function renderQRAscii(code: string): string {
  let out = "";
  qrTerminal.generate(code, { small: true }, (qrcode) => { out = qrcode; });
  return out;
}

export function displayQR(code: string): void {
  process.stderr.write(`\nScan to pair:\n\n${renderQRAscii(code)}\n`);
}
