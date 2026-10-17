import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listTimelineSessions, type TimelineSessionSummary } from "./timeline-store";

type UseHistorySessionListOptions = {
  deviceId: string | null;
  onError: (message: string) => void;
  onSessionsLoaded: (sessions: TimelineSessionSummary[]) => void;
};

type HistorySessionList = {
  historySessions: TimelineSessionSummary[];
  historyListStatus: "idle" | "loading" | "success" | "error";
  refreshHistory: () => Promise<void>;
  invalidateHistoryList: () => void;
};

/** Keeps local history reads scoped to the computer that started them. */
export function useHistorySessionList({ deviceId, onError, onSessionsLoaded }: UseHistorySessionListOptions): HistorySessionList {
  const [loadedSessions, setLoadedSessions] = useState<TimelineSessionSummary[]>([]);
  const [readState, setReadState] = useState<{ deviceId: string | null; status: HistorySessionList["historyListStatus"] }>({ deviceId: null, status: "idle" });
  const deviceIdRef = useRef(deviceId);
  const requestGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const onErrorRef = useRef(onError);
  const onSessionsLoadedRef = useRef(onSessionsLoaded);
  useLayoutEffect(() => {
    requestGenerationRef.current += 1;
    deviceIdRef.current = deviceId;
  }, [deviceId]);
  useLayoutEffect(() => {
    onErrorRef.current = onError;
    onSessionsLoadedRef.current = onSessionsLoaded;
  }, [onError, onSessionsLoaded]);

  const invalidateHistoryList = useCallback(() => {
    requestGenerationRef.current += 1;
  }, []);

  const refreshHistory = useCallback(async () => {
    const requestedDeviceId = deviceId;
    // A callback retained by an old computer must not invalidate a newer request.
    if (requestedDeviceId !== deviceIdRef.current) return;
    const requestGeneration = ++requestGenerationRef.current;
    const isCurrentRequest = () => mountedRef.current
      && requestGeneration === requestGenerationRef.current
      && requestedDeviceId === deviceIdRef.current;

    await Promise.resolve();
    if (!isCurrentRequest()) return;
    if (!requestedDeviceId) {
      setLoadedSessions([]);
      setReadState({ deviceId: null, status: "idle" });
      return;
    }
    setReadState({ deviceId: requestedDeviceId, status: "loading" });
    try {
      const sessions = await listTimelineSessions(requestedDeviceId);
      if (!isCurrentRequest()) return;
      setLoadedSessions(sessions);
      setReadState({ deviceId: requestedDeviceId, status: "success" });
      onSessionsLoadedRef.current(sessions);
    } catch {
      if (isCurrentRequest()) {
        setReadState({ deviceId: requestedDeviceId, status: "error" });
        onErrorRef.current("Could not read saved conversations.");
      }
    }
  }, [deviceId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshHistory(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshHistory]);

  const historySessions = useMemo(
    () => deviceId ? loadedSessions.filter((session) => session.deviceId === deviceId) : [],
    [deviceId, loadedSessions],
  );

  const historyListStatus = !deviceId ? "idle" : readState.deviceId !== deviceId ? "loading" : readState.status;
  return { historySessions, historyListStatus, refreshHistory, invalidateHistoryList };
}
