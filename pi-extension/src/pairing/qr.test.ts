import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_PATTERN,
  PAIRING_INVITE_TTL_MS,
  PAIR_TTL_MAX_MS,
  PAIR_TTL_MIN_MS,
  QRSession,
  type CodeReservation,
  clampPairTtlMs,
} from "./qr.js";

describe("clampPairTtlMs", () => {
  test("passes a value inside the range unchanged", () => {
    expect(clampPairTtlMs(120_000)).toBe(120_000);
  });
  test("clamps below the minimum", () => {
    expect(clampPairTtlMs(1_000)).toBe(PAIR_TTL_MIN_MS);
  });
  test("clamps a 600-second value to the 300-second maximum", () => {
    expect(clampPairTtlMs(600_000)).toBe(300_000);
  });
  test("keeps the default, minimum, and maximum values unchanged", () => {
    expect(clampPairTtlMs(PAIRING_INVITE_TTL_MS)).toBe(PAIRING_INVITE_TTL_MS);
    expect(clampPairTtlMs(PAIR_TTL_MIN_MS)).toBe(PAIR_TTL_MIN_MS);
    expect(clampPairTtlMs(PAIR_TTL_MAX_MS)).toBe(PAIR_TTL_MAX_MS);
  });
  test("non-finite values fall back to the five-minute default", () => {
    expect(clampPairTtlMs(Number.NaN)).toBe(PAIRING_INVITE_TTL_MS);
    expect(clampPairTtlMs(Number.POSITIVE_INFINITY)).toBe(PAIRING_INVITE_TTL_MS);
  });
});

describe("QRSession pairing invites", () => {
  test("generates an eight-character Crockford Base32 code", () => {
    const session = new QRSession();
    const invite = session.issueCode();

    expect(invite.code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(invite.code).toMatch(PAIRING_CODE_PATTERN);
    expect(invite.code).not.toMatch(/[ILOU]/);
  });

  test("uses a five-minute default TTL", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000_000));
      expect(new QRSession().issueCode().expiresAt).toBe(1_000_000 + PAIRING_INVITE_TTL_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  test("issuing a new invite invalidates the previous invite", () => {
    const session = new QRSession();
    const first = session.issueCode().code;
    const second = session.issueCode().code;

    expect(second).not.toBe(first);
    expect(session.reserveCode(first, "owner-a", "request-1").status).toBe("unknown");
    expect(session.getActiveInvite()?.code).toBe(second);
  });

  test("reserves and commits a code, then replays the same completion", () => {
    const session = new QRSession();
    const { code } = session.issueCode();
    const first = session.reserveCode(code, "owner-a", "request-1");
    expect(first.status).toBe("reserved");
    if (first.status !== "reserved") throw new Error("expected reservation");
    const completion = { type: "pair_ok", requestId: "request-1" };

    expect(session.commitCode(first.reservation, completion)).toBe(true);
    expect(session.reserveCode(code, "owner-a", "request-1")).toEqual({ status: "committed", completion });
    expect(session.isReservationCurrent(first.reservation)).toBe(false);
  });

  test("replays a committed result for the same request after invite expiry", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(0));
      const session = new QRSession();
      const { code } = session.issueCode(10_000);
      const first = session.reserveCode(code, "owner-a", "request-1");
      if (first.status !== "reserved") throw new Error("expected reservation");
      const completion = { type: "pair_ok", requestId: "request-1" };
      expect(session.commitCode(first.reservation, completion)).toBe(true);
      vi.setSystemTime(new Date(10_000));

      expect(session.reserveCode(code, "owner-a", "request-1")).toEqual({ status: "committed", completion });
      expect(session.reserveCode(code, "owner-b", "request-1").status).toBe("consumed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects an uncommitted code after expiry", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(0));
      const session = new QRSession();
      const { code } = session.issueCode(10_000);
      vi.setSystemTime(new Date(10_000));
      expect(session.reserveCode(code, "owner-a", "request-1")).toEqual({ status: "expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("only the same Owner and request can reuse a reservation", () => {
    const session = new QRSession();
    const { code } = session.issueCode();

    expect(session.reserveCode(code, "owner-a", "request-1").status).toBe("reserved");
    expect(session.reserveCode(code, "owner-b", "request-1").status).toBe("consumed");
    expect(session.reserveCode(code, "owner-a", "request-2").status).toBe("consumed");
  });

  test("release keeps the code private to the original request", () => {
    const session = new QRSession();
    const { code } = session.issueCode();
    const result = session.reserveCode(code, "owner-a", "request-1");
    if (result.status !== "reserved") throw new Error("expected reservation");

    expect(session.releaseCode(result.reservation)).toBe(true);
    expect(session.reserveCode(code, "owner-b", "request-1").status).toBe("consumed");
    const retry = session.reserveCode(code, "owner-a", "request-1");
    expect(retry.status).toBe("reserved");
    if (retry.status === "reserved") expect(retry.reservation).not.toBe(result.reservation);
  });

  test("rejects stale reservations and invalid commits", () => {
    const session = new QRSession();
    const { code } = session.issueCode();
    const result = session.reserveCode(code, "owner-a", "request-1");
    if (result.status !== "reserved") throw new Error("expected reservation");
    const forged = { code, ownerId: "owner-a", requestId: "request-1" } as CodeReservation;

    expect(session.isReservationCurrent(forged)).toBe(false);
    expect(session.commitCode(forged, "completion")).toBe(false);
    expect(session.commitCode(result.reservation, "completion")).toBe(true);
    expect(session.commitCode(result.reservation, "other")).toBe(false);
  });

  test("consumes a code only once", () => {
    const session = new QRSession();
    const { code } = session.issueCode();

    expect(session.consumeCode(code)).toBe("ok");
    expect(session.consumeCode(code)).toBe("consumed");
  });

  test("clear removes the active invite and its replay state", () => {
    const session = new QRSession();
    const { code } = session.issueCode();

    session.clear();
    expect(session.getActiveInvite()).toBeNull();
    expect(session.reserveCode(code, "owner-a", "request-1").status).toBe("unknown");
  });
});
