import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listTimelineSessions, type TimelineSessionSummary } from "./timeline-store";

type UseHistorySessionListOptions = {
  deviceId: string | null;
  onError: (message: string) => void;
  onSessionsLoaded: (sessions: TimelineSessionSummary[]) => void;
};

type HistorySessionList = {
  historySessions: TimelineSessionSummary[];
  refreshHistory: () => Promise<void>;
  invalidateHistoryList: () => void;
};

/** Keeps local history reads scoped to the computer that started them. */
export function useHistorySessionList({ deviceId, onError, onSessionsLoaded }: UseHistorySessionListOptions): HistorySessionList {
  const [loadedSessions, setLoadedSessions] = useState<TimelineSessionSummary[]>([]);
  const deviceIdRef = useRef(deviceId);
  const requestGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const onErrorRef = useRef(onError);
  const onSessionsLoadedRef = useRef(onSessionsLoaded);
  useEffect(() => {
    requestGenerationRef.current += 1;
    deviceIdRef.current = deviceId;
    onErrorRef.current = onError;
    onSessionsLoadedRef.current = onSessionsLoaded;
  }, [deviceId, onError, onSessionsLoaded]);

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
      return;
    }
    try {
      const sessions = await listTimelineSessions(requestedDeviceId);
      if (!isCurrentRequest()) return;
      setLoadedSessions(sessions);
      onSessionsLoadedRef.current(sessions);
    } catch {
      if (isCurrentRequest()) onErrorRef.current("Could not read saved conversations.");
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

  return { historySessions, refreshHistory, invalidateHistoryList };
}
