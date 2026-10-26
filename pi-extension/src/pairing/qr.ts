import { randomBytes } from "node:crypto";
import { PAIRING_INVITE_TTL_MS, PAIR_TTL_MAX_MS, PAIR_TTL_MIN_MS } from "@pi-reach/protocol/outer";
import QRCode from "qrcode-terminal/vendor/QRCode/index.js";
import QRErrorCorrectLevel from "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js";

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

// 二维码规范要求四周至少 4 个模块的浅色静区。
export const QR_QUIET_ZONE_MODULES = 4;
const QR_AUTO_VERSION = -1;
// 显式使用 256 色立方体的纯黑前景与纯白背景，不随终端主题调色板反色。
const QR_COLORS = "\x1b[38;5;16;48;5;231m";
const ANSI_RESET = "\x1b[0m";
// 每个字符格的上下两半各表示一个模块，按「上深 ×2 + 下深」取字符。
const HALF_BLOCKS = [" ", "\u2584", "\u2580", "\u2588"] as const;

/**
 * 渲染可在任意终端主题下扫描的二维码。8 位配对码在 Q 级纠错下仍是 21×21，
 * 尺寸与 L 级相同，但能容忍更多拍摄损失。
 */
export function renderQRAscii(code: string): string {
  const qr = new QRCode(QR_AUTO_VERSION, QRErrorCorrectLevel.Q);
  qr.addData(code);
  qr.make();
  const size = qr.getModuleCount();
  const span = size + QR_QUIET_ZONE_MODULES * 2;
  const isDark = (row: number, col: number): boolean => {
    const r = row - QR_QUIET_ZONE_MODULES;
    const c = col - QR_QUIET_ZONE_MODULES;
    return r >= 0 && c >= 0 && r < size && c < size && qr.isDark(r, c);
  };
  const lines: string[] = [];
  for (let row = 0; row < span; row += 2) {
    let line = "";
    for (let col = 0; col < span; col++) line += HALF_BLOCKS[(isDark(row, col) ? 2 : 0) + (isDark(row + 1, col) ? 1 : 0)];
    lines.push(`${QR_COLORS}${line}${ANSI_RESET}`);
  }
  return lines.join("\n");
}
