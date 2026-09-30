import { useCallback, useEffect, useRef } from "react";
import type { PeerChannel } from "@/lib/pi-reach/peer-channel";
import { getPwaDatabase, makePwaDeviceId, type PwaEndpointRecord } from "./db";
import type { TimelineRuntime, TimelineScope } from "./timeline-runtime";
import { makeTimelineScopeId, saveTimelineSessionName } from "./timeline-store";

type MutableRef<T> = { current: T };
type Options = {
  endpoint: PwaEndpointRecord | null;
  runtimeRef: MutableRef<TimelineRuntime>;
  channelRef: MutableRef<PeerChannel | null>;
  helloRequestRef: MutableRef<string | null>;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
  replacingSession: boolean;
};

/** 名称只绑定已握手的会话，离线缓存和历史阅读不能重新绑定 endpoint。 */
export function useHistorySessionNames({ endpoint, runtimeRef, channelRef, helloRequestRef, onSaved, onError, replacingSession }: Options) {
  const endpointRef = useRef(endpoint);
  const callbacksRef = useRef({ onSaved, onError });
  const epochRef = useRef(0);
  const pendingRef = useRef(Promise.resolve());
  const scheduledNamesRef = useRef(new Map<string, string>());

  useEffect(() => { callbacksRef.current = { onSaved, onError }; }, [onSaved, onError]);

  const rememberSessionName = useCallback((scope: TimelineScope) => {
    const current = endpointRef.current;
    if (!current?.online || current.deviceId !== scope.deviceId || current.endpointId !== scope.endpointId
      || current.runtimeInstanceId !== scope.runtimeInstanceId || channelRef.current?.channelId !== scope.channelId
      || helloRequestRef.current !== null) return;
    const name = current.name?.trim();
    if (!name) return;
    const key = makeTimelineScopeId(scope);
    if (scheduledNamesRef.current.get(key) === name) return;
    scheduledNamesRef.current.set(key, name);
    const epoch = epochRef.current;
    // 顺序写入，避免旧名称的异步保存晚于新名称落盘。
    pendingRef.current = pendingRef.current.then(async () => {
      if (epoch !== epochRef.current) return;
      const db = getPwaDatabase();
      await db.transaction("rw", [db.devices, db.sessions], async () => {
        if (!await db.devices.get(makePwaDeviceId(scope.deviceId))) return;
        await saveTimelineSessionName(scope, name);
      });
      if (epoch === epochRef.current) await callbacksRef.current.onSaved();
    }).catch(() => {
      if (epoch !== epochRef.current) return;
      if (scheduledNamesRef.current.get(key) === name) scheduledNamesRef.current.delete(key);
      callbacksRef.current.onError("Could not save the conversation name.");
    });
  }, [channelRef, helloRequestRef]);

  useEffect(() => {
    endpointRef.current = endpoint;
    const scope = runtimeRef.current.currentScope;
    if (scope && !replacingSession) rememberSessionName(scope);
  }, [endpoint, runtimeRef, rememberSessionName, replacingSession]);

  const invalidateSessionNames = useCallback(async () => {
    epochRef.current += 1;
    scheduledNamesRef.current.clear();
    await pendingRef.current;
  }, []);

  useEffect(() => () => { epochRef.current += 1; }, []);

  return { rememberSessionName, invalidateSessionNames };
}
