import { useCallback, useEffect, useRef, useState } from "react";
import { PeerChannel } from "@/lib/pi-reach/peer-channel";
import { RelayClient } from "@/lib/pi-reach/relay-client";
import { browserName } from "@/lib/pwa/runtime";
import { createPairRequest, normalizePairCode, normalizePairDeviceId } from "@/lib/pi-reach/pairing";
import { makePwaDeviceId, type PwaDeviceRecord } from "@/lib/pwa/db";
import type { ControlFrame } from "@/lib/pi-reach/types";
import type { ServerFrame } from "@/lib/pi-reach/protocol-v2/frames";

const PAIRING_TIMEOUT_MS = 15_000;
const PAIRING_MAX_ATTEMPTS = 2;
/** 配对失败原因；界面按原因显示在弹窗内输入框下方，不使用 Toast。 */
export type PairingErrorCode =
  | "invalid_code"
  | "unknown_code"
  | "expired_code"
  | "consumed_code"
  | "stale_target"
  | "rate_limited"
  | "relay_unavailable"
  | "failed";
const PAIR_ERROR_CODES = {
  token_unknown: "unknown_code",
  token_expired: "expired_code",
  token_consumed: "consumed_code",
  internal_error: "failed",
} as const satisfies Record<Extract<ServerFrame, { type: "pair_error" }>["code"], PairingErrorCode>;

type DevicePairingState = "idle" | "scanning" | "pairing";
type PairingTarget = Extract<ControlFrame, { type: "pairing_target" }>;
type PairingAttempt = {
  relay: RelayClient;
  channel: PeerChannel | null;
  timer: ReturnType<typeof setTimeout> | null;
  reject: ((reason?: unknown) => void) | null;
  unsubscribeClose: (() => void) | null;
  unsubscribeControl: (() => void) | null;
  requestId: string;
  code: string;
  requestSent: boolean;
  cancelled: boolean;
  cleanedUp: boolean;
};
class PairingFailure extends Error {
  constructor(readonly code: PairingErrorCode) {
    super(code);
  }
}
class RetryablePairingError extends PairingFailure {}
export type DevicePairingResult = {
  device: PwaDeviceRecord;
  endpointId: string;
};
export type UseDevicePairingOptions = {
  getOwnerRelay: () => RelayClient | null;
  relayUrl: string;
  onPaired: (result: DevicePairingResult) => Promise<void>;
  /** 可选的失败观察者；失败原因同时保存在控制器的 error 中。 */
  onError?: (error: PairingErrorCode | null) => void;
};
export type DevicePairingController = {
  state: DevicePairingState;
  error: PairingErrorCode | null;
  open: () => void;
  close: () => void;
  clearError: () => void;
  pairFromCode: (raw: string) => Promise<void>;
};



export function useDevicePairing({ getOwnerRelay, relayUrl, onPaired, onError }: UseDevicePairingOptions): DevicePairingController {
  const [state, setState] = useState<DevicePairingState>("idle");
  const [error, setErrorState] = useState<PairingErrorCode | null>(null);
  const relayUrlRef = useRef(relayUrl);
  const onPairedRef = useRef(onPaired);
  const onErrorRef = useRef(onError);
  const attemptRef = useRef<PairingAttempt | null>(null);
  useEffect(() => {
    relayUrlRef.current = relayUrl;
    onPairedRef.current = onPaired;
    onErrorRef.current = onError;
  }, [onError, onPaired, relayUrl]);

  const closeAttemptTransport = useCallback((attempt: PairingAttempt) => {
    if (attempt.timer !== null) {
      clearTimeout(attempt.timer);
      attempt.timer = null;
    }
    attempt.unsubscribeClose?.();
    attempt.unsubscribeClose = null;
    attempt.unsubscribeControl?.();
    attempt.unsubscribeControl = null;
    attempt.channel?.close();
    attempt.channel = null;
    attempt.reject = null;
  }, []);
  const cleanupAttempt = useCallback((attempt: PairingAttempt) => {
    if (attempt.cleanedUp) return;
    attempt.cleanedUp = true;
    closeAttemptTransport(attempt);
    if (attemptRef.current === attempt) attemptRef.current = null;
  }, [closeAttemptTransport]);
  const cancelAttempt = useCallback((attempt: PairingAttempt, message: string) => {
    attempt.cancelled = true;
    attempt.reject?.(new Error(message));
    cleanupAttempt(attempt);
  }, [cleanupAttempt]);
  useEffect(() => () => {
    const attempt = attemptRef.current;
    if (attempt) cancelAttempt(attempt, "Pairing cancelled because the PWA was unmounted.");
  }, [cancelAttempt]);

  const reportError = useCallback((code: PairingErrorCode | null) => {
    setErrorState(code);
    onErrorRef.current?.(code);
  }, []);
  const open = useCallback(() => { setErrorState(null); setState("scanning"); }, []);
  const close = useCallback(() => {
    const attempt = attemptRef.current;
    if (attempt) cancelAttempt(attempt, "Pairing cancelled by the user.");
    setErrorState(null);
    setState("idle");
  }, [cancelAttempt]);
  const clearError = useCallback(() => setErrorState(null), []);
  const pairFromCode = useCallback(async (raw: string) => {
    const code = normalizePairCode(raw);
    if (!code) {
      reportError("invalid_code");
      return;
    }
    const relay = getOwnerRelay();
    if (!relay) {
      reportError("relay_unavailable");
      return;
    }
    const previousAttempt = attemptRef.current;
    if (previousAttempt) cancelAttempt(previousAttempt, "Pairing cancelled by a newer pairing attempt.");
    setState("pairing");
    reportError(null);
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const request = createPairRequest(code, browserName(), requestId);
    const attempt: PairingAttempt = { relay, channel: null, timer: null, reject: null, unsubscribeClose: null, unsubscribeControl: null, requestId, code, requestSent: false, cancelled: false, cleanedUp: false };
    attemptRef.current = attempt;
    const isActive = () => attemptRef.current === attempt && !attempt.cancelled;
    try {
      let paired: PwaDeviceRecord | null = null;
      let pairedEndpointId: string | null = null;
      for (let attemptNumber = 1; attemptNumber <= PAIRING_MAX_ATTEMPTS && !paired; attemptNumber += 1) {
        try {
          const result = await new Promise<{ device: PwaDeviceRecord; endpointId: string }>((resolve, reject) => {
            let settled = false;
            const finish = (callback: () => void) => {
              if (settled) return;
              settled = true;
              if (attempt.timer !== null) { clearTimeout(attempt.timer); attempt.timer = null; }
              attempt.unsubscribeClose?.();
              attempt.unsubscribeClose = null;
              attempt.unsubscribeControl?.();
              attempt.unsubscribeControl = null;
              callback();
            };
            const fail = (reason: PairingErrorCode | Error, retryable: boolean) => {
              if (reason instanceof Error) {
                finish(() => reject(reason));
                return;
              }
              finish(() => reject(retryable ? new RetryablePairingError(reason) : new PairingFailure(reason)));
            };
            attempt.reject = (reason) => fail(reason instanceof Error ? reason : new Error("Pairing cancelled."), false);
            attempt.unsubscribeClose = relay.on("close", () => {
              if (isActive()) fail("relay_unavailable", attempt.requestSent);
            });
            attempt.unsubscribeControl = relay.on("control", (frame) => {
              if (!isActive() || frame.type === "endpoints" || frame.type === "endpoint_announced" || frame.type === "endpoint_updated" || frame.type === "endpoint_ended" || frame.in_reply_to !== requestId) return;
              if (frame.type === "pairing_code_error") {
                fail(frame.reason, false);
                return;
              }
              if (attempt.channel) return;
              const target = frame as PairingTarget;
              const targetCode = normalizePairCode(target.code);
              if (targetCode !== code) {
                fail("failed", false);
                return;
              }
              let deviceId: string;
              try {
                deviceId = normalizePairDeviceId(target.device_id);
              } catch {
                fail("failed", false);
                return;
              }
              const channel = new PeerChannel({
                relay,
                endpoint: { deviceId, endpointId: target.endpoint_id, runtimeInstanceId: target.runtime_instance_id },
                onPairOk: (ok) => {
                  if (!isActive() || ok.in_reply_to !== request.id) return;
                  if (ok.endpoint_id !== target.endpoint_id) {
                    fail("failed", false);
                    return;
                  }
                  finish(() => resolve({
                    endpointId: target.endpoint_id,
                    device: {
                      id: makePwaDeviceId(deviceId),
                      deviceId,
                      relayUrl: relayUrlRef.current,
                      pairedAt: new Date().toISOString(),
                      hostname: ok.hostname,
                      harness: ok.harness,
                    },
                  }));
                },
                onPairError: (pairError) => {
                  if (isActive() && pairError.in_reply_to === request.id) fail(PAIR_ERROR_CODES[pairError.code], false);
                },
                onMalformed: () => { if (isActive()) fail("failed", false); },
              });
              attempt.channel = channel;
              const requestSent = channel.sendPairRequest(request);
              attempt.requestSent = attempt.requestSent || requestSent;
              if (!requestSent) fail("relay_unavailable", false);
            });
            attempt.timer = setTimeout(() => fail("failed", attempt.requestSent), PAIRING_TIMEOUT_MS);
            void relay.connect().then(() => {
              if (!isActive()) return;
              const resolveSent = relay.sendControl({ type: "resolve_pairing_code", request_id: requestId, code });
              attempt.requestSent = attempt.requestSent || resolveSent;
              if (!resolveSent) fail("relay_unavailable", false);
            }).catch(() => fail("relay_unavailable", false));
          });
          paired = result.device;
          pairedEndpointId = result.endpointId;
        } catch (pairingError) {
          closeAttemptTransport(attempt);
          if (!(pairingError instanceof RetryablePairingError) || attemptNumber === PAIRING_MAX_ATTEMPTS || !isActive()) throw pairingError;
          attempt.requestSent = false;
        }
      }
      if (!paired || !pairedEndpointId || !isActive()) return;
      await onPairedRef.current({ device: paired, endpointId: pairedEndpointId });
      if (isActive()) setState("idle");
    } catch (pairingError) {
      if (isActive()) {
        reportError(pairingError instanceof PairingFailure ? pairingError.code : "failed");
        setState("scanning");
      }
    } finally {
      cleanupAttempt(attempt);
    }
  }, [cancelAttempt, cleanupAttempt, closeAttemptTransport, getOwnerRelay, reportError]);

  return { state, error, open, close, clearError, pairFromCode };
}
