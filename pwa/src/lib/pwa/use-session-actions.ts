import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerFrame } from "@/lib/pi-reach/protocol-v2/frames";
import { actionReply, observeNewSession, OPERATION_CONFIRMATION_TIMEOUT_MS, type PendingSessionAction, type PendingStop } from "./operation-feedback";

/** 复用调用方的 request id 与连接作用域；ref 是同步门禁，state 只负责呈现。 */
export function useSessionActions() {
  const [pendingAction, setActionState] = useState<PendingSessionAction | null>(null);
  const pendingActionRef = useRef<PendingSessionAction | null>(null);
  const [stopRequest, setStopState] = useState<PendingStop | null>(null);
  const stopRequestRef = useRef<PendingStop | null>(null);
  const setPendingAction = useCallback((next: PendingSessionAction | null) => {
    pendingActionRef.current = next;
    setActionState(next);
  }, []);
  const setStopRequest = useCallback((next: PendingStop | null) => {
    stopRequestRef.current = next;
    setStopState(next);
  }, []);
  const receiveAction = useCallback((frame: Extract<ServerFrame, { type: "action_ok" | "action_error" }>) => {
    const previous = pendingActionRef.current;
    const next = actionReply(previous, frame);
    if (previous !== next) setPendingAction(next);
  }, [setPendingAction]);
  const observeSession = useCallback((sessionId: string, dataReady: boolean) => {
    const previous = pendingActionRef.current;
    if (previous?.action !== "session_new" || previous.readySessionId === sessionId && (!dataReady || previous.dataSessionId === sessionId)) return;
    setPendingAction(observeNewSession(previous, sessionId, dataReady));
  }, [setPendingAction]);
  const disconnectActions = useCallback(() => {
    const pending = pendingActionRef.current;
    if (pending && pending.phase !== "unknown") setPendingAction({ ...pending, phase: "unknown" });
    const stop = stopRequestRef.current;
    if (stop && !stop.unknown) setStopRequest({ ...stop, unknown: true });
  }, [setPendingAction, setStopRequest]);
  const resetActions = useCallback(() => {
    setPendingAction(null);
    setStopRequest(null);
  }, [setPendingAction, setStopRequest]);
  useEffect(() => {
    if (!pendingAction || pendingAction.phase === "unknown") return;
    const requestId = pendingAction.id;
    const timer = window.setTimeout(() => {
      const current = pendingActionRef.current;
      if (current?.id === requestId) setPendingAction({ ...current, phase: "unknown" });
    }, Math.max(0, OPERATION_CONFIRMATION_TIMEOUT_MS - (Date.now() - pendingAction.startedAt)));
    return () => window.clearTimeout(timer);
  }, [pendingAction, setPendingAction]);
  useEffect(() => {
    if (!stopRequest || stopRequest.unknown) return;
    const requestId = stopRequest.id;
    const timer = window.setTimeout(() => {
      const current = stopRequestRef.current;
      if (current?.id === requestId) setStopRequest({ ...current, unknown: true });
    }, Math.max(0, OPERATION_CONFIRMATION_TIMEOUT_MS - (Date.now() - stopRequest.startedAt)));
    return () => window.clearTimeout(timer);
  }, [setStopRequest, stopRequest]);
  return { pendingAction, pendingActionRef, setPendingAction, receiveAction, observeSession, stopRequest, stopRequestRef, setStopRequest, disconnectActions, resetActions };
}
