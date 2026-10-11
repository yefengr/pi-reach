import { useCallback, useEffect, useRef } from "react";
import type { PeerChannel } from "@/lib/pi-reach/peer-channel";
import { getPwaDatabase, makePwaDeviceId, type PwaEndpointRecord } from "./db";
import type { TimelineRuntime, TimelineScope } from "./timeline-runtime";
import { makeTimelineScopeId, saveTimelineSessionDetails, type TimelineSessionDetails } from "./timeline-store";

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

function endpointSessionDetails(endpoint: PwaEndpointRecord): TimelineSessionDetails {
  const name = endpoint.name?.trim();
  const model = endpoint.model?.trim();
  const thinking = endpoint.thinking?.trim();
  return { ...(name ? { name } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}

/** 名称、模型与思考级别只绑定已握手的会话，离线缓存和历史阅读不能重新绑定 endpoint；Pi 每次报告变化时写入一次。 */
export function useHistorySessionDetails({ endpoint, runtimeRef, channelRef, helloRequestRef, onSaved, onError, replacingSession }: Options) {
  const endpointRef = useRef(endpoint);
  const callbacksRef = useRef({ onSaved, onError });
  const epochRef = useRef(0);
  const pendingRef = useRef(Promise.resolve());
  const scheduledDetailsRef = useRef(new Map<string, string>());

  useEffect(() => { callbacksRef.current = { onSaved, onError }; }, [onSaved, onError]);

  const rememberSessionDetails = useCallback((scope: TimelineScope) => {
    const current = endpointRef.current;
    if (!current?.online || current.deviceId !== scope.deviceId || current.endpointId !== scope.endpointId
      || current.runtimeInstanceId !== scope.runtimeInstanceId || channelRef.current?.channelId !== scope.channelId
      || helloRequestRef.current !== null) return;
    const details = endpointSessionDetails(current);
    if (Object.keys(details).length === 0) return;
    const key = makeTimelineScopeId(scope);
    const signature = JSON.stringify(details);
    if (scheduledDetailsRef.current.get(key) === signature) return;
    scheduledDetailsRef.current.set(key, signature);
    const epoch = epochRef.current;
    // 顺序写入，避免旧值的异步保存晚于新值落盘。
    pendingRef.current = pendingRef.current.then(async () => {
      if (epoch !== epochRef.current) return;
      const db = getPwaDatabase();
      await db.transaction("rw", [db.devices, db.sessions], async () => {
        if (!await db.devices.get(makePwaDeviceId(scope.deviceId))) return;
        await saveTimelineSessionDetails(scope, details);
      });
      if (epoch === epochRef.current) await callbacksRef.current.onSaved();
    }).catch(() => {
      if (epoch !== epochRef.current) return;
      if (scheduledDetailsRef.current.get(key) === signature) scheduledDetailsRef.current.delete(key);
      callbacksRef.current.onError("Could not update local history.");
    });
  }, [channelRef, helloRequestRef]);

  useEffect(() => {
    endpointRef.current = endpoint;
    const scope = runtimeRef.current.currentScope;
    if (scope && !replacingSession) rememberSessionDetails(scope);
  }, [endpoint, runtimeRef, rememberSessionDetails, replacingSession]);

  const invalidateSessionDetails = useCallback(async () => {
    epochRef.current += 1;
    scheduledDetailsRef.current.clear();
    await pendingRef.current;
  }, []);

  useEffect(() => () => { epochRef.current += 1; }, []);

  return { rememberSessionDetails, invalidateSessionDetails };
}
