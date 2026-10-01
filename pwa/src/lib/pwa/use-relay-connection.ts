import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { PwaConnectionBannerKind } from "@/components/pwa/pwa-app-actions";
import type { ConnectionViewState } from "@/components/pwa/workspace-view";
import { RelayClient } from "@/lib/pi-reach/relay-client";
import type { ControlFrame, OwnerKeyPair } from "@/lib/pi-reach/types";
import { reconnectDelayMs, ReconnectState, type ReconnectTrigger } from "@/lib/pwa/reconnect-state";
import type { PwaDeviceRecord } from "@/lib/pwa/db";

type UseRelayConnectionOptions = {
  identity: OwnerKeyPair | null;
  ready: boolean;
  relayUrl: string;
  devices: readonly PwaDeviceRecord[];
  onControl: (frame: ControlFrame) => void;
  onSessionDisconnect: (retainSnapshot: boolean) => void;
  onAllEndpointsOffline: () => void;
  onRetryFinished: () => void;
  setConnection: Dispatch<SetStateAction<ConnectionViewState>>;
  setConnectionFeedback: Dispatch<SetStateAction<PwaConnectionBannerKind | null>>;
};

/** Maintains the Owner Relay transport while session channels remain app-owned. */
export function useRelayConnection({
  identity,
  ready,
  relayUrl,
  devices,
  onControl,
  onSessionDisconnect,
  onAllEndpointsOffline,
  onRetryFinished,
  setConnection,
  setConnectionFeedback,
}: UseRelayConnectionOptions) {
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [generation, setGeneration] = useState(0);
  // Relay 与网络本身的状态，与会话连接分开：未打开会话时标题区和连接提示条只看它。
  const [relayStatus, setRelayStatus] = useState<ConnectionViewState>("connecting");
  const [relayVersion, setRelayVersion] = useState<string | null>(null);
  const devicesRef = useRef(devices);
  const relayRef = useRef<RelayClient | null>(null);
  const reconnectNowRef = useRef<(() => void) | null>(null);
  const intentionalCloseRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const onlineRef = useRef(typeof navigator === "undefined" || navigator.onLine);

  useEffect(() => { devicesRef.current = devices; }, [devices]);

  useEffect(() => {
    if (!identity || !ready) return;
    let cancelled = false;
    let activeToken = 0;
    const controller = new ReconnectState();
    const relay = new RelayClient({ relayUrl, identity });
    relayRef.current = relay;
    let connectRelay: (token: number) => void = () => undefined;
    // Relay 层的状态变化同时写入会话连接状态（保持原有行为）与独立的 Relay 状态。
    const reportRelay = (state: ConnectionViewState) => {
      setRelayStatus(state);
      setConnection(state);
    };

    const scheduleReconnect = (trigger: ReconnectTrigger): boolean => {
      if (cancelled || !onlineRef.current) {
        if (!onlineRef.current) reportRelay("no_network");
        return false;
      }
      const attempt = retryAttemptRef.current + 1;
      const token = activeToken;
      if (!controller.request(trigger, () => {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          if (cancelled || !onlineRef.current) {
            controller.cancel();
            reportRelay("no_network");
            return;
          }
          activeToken = controller.beginConnection();
          connectRelay(activeToken);
        }, reconnectDelayMs(attempt));
      }, token)) return false;
      retryAttemptRef.current = attempt;
      setRetryAttempt(attempt);
      onRetryFinished();
      reportRelay("retrying");
      return true;
    };

    connectRelay = (token: number) => {
      if (cancelled || !onlineRef.current) return;
      intentionalCloseRef.current = false;
      setRelayVersion(null);
      reportRelay("connecting");
      void relay.connect().then(() => {
        if (cancelled || relayRef.current !== relay || !onlineRef.current || token !== activeToken) return;
        activeToken = controller.beginConnection();
        retryAttemptRef.current = 0;
        setRetryAttempt(0);
        if (!relay.subscribeEndpoints(devicesRef.current.map((device) => device.deviceId))) {
          relay.close(1000, "Relay subscription failed");
          return;
        }
        setRelayStatus("online");
        setGeneration((current) => current + 1);
      }).catch(() => {
        if (cancelled || relayRef.current !== relay) return;
        setConnectionFeedback("relay");
        scheduleReconnect("connect_rejected");
      });
    };

    const reconnectNow = () => {
      if (cancelled || !onlineRef.current) {
        if (!onlineRef.current) reportRelay("no_network");
        return;
      }
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      controller.userRecover();
      retryAttemptRef.current = 0;
      setRetryAttempt(0);
      activeToken = controller.beginConnection();
      connectRelay(activeToken);
    };
    reconnectNowRef.current = reconnectNow;

    const unsubscribeControl = relay.on("control", (frame) => {
      if (cancelled || relayRef.current !== relay) return;
      if (frame.type === "relay_info") {
        setRelayVersion(frame.version);
        return;
      }
      onControl(frame);
    });
    const unsubscribeState = relay.on("state", (state) => {
      if (cancelled || relayRef.current !== relay || state !== "closed") return;
      setRelayVersion(null);
      onSessionDisconnect(!intentionalCloseRef.current);
      onAllEndpointsOffline();
      if (!onlineRef.current) {
        intentionalCloseRef.current = false;
        onRetryFinished();
        reportRelay("no_network");
        return;
      }
      if (intentionalCloseRef.current) {
        intentionalCloseRef.current = false;
        onRetryFinished();
        reportRelay("offline");
        return;
      }
      if (!scheduleReconnect("closed") && !reconnectTimerRef.current) reportRelay("offline");
    });
    const unsubscribeError = relay.on("error", () => {
      if (cancelled || relayRef.current !== relay) return;
      setConnectionFeedback("relay");
      scheduleReconnect("error");
    });

    const handleOffline = () => {
      onlineRef.current = false;
      intentionalCloseRef.current = false;
      controller.cancel();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      onSessionDisconnect(true);
      onRetryFinished();
      relay.close(1000, "browser offline");
      setConnectionFeedback("network");
      reportRelay("no_network");
    };
    const handleOnline = () => {
      onlineRef.current = true;
      setConnectionFeedback((current) => current === "network" ? "relay" : current);
      controller.userRecover();
      retryAttemptRef.current = 0;
      setRetryAttempt(0);
      if (relay.state === "open") {
        relay.subscribeEndpoints(devicesRef.current.map((device) => device.deviceId));
        setRelayStatus("online");
        setGeneration((current) => current + 1);
      } else reconnectNow();
    };
    const handleVisibility = () => { if (document.visibilityState === "visible" && navigator.onLine) handleOnline(); };
    const handlePageShow = () => { if (navigator.onLine) handleOnline(); };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pageshow", handlePageShow);
    onlineRef.current = typeof navigator === "undefined" || navigator.onLine;
    activeToken = controller.beginConnection();
    if (onlineRef.current) connectRelay(activeToken);
    else {
      setConnectionFeedback("network");
      reportRelay("no_network");
    }

    return () => {
      cancelled = true;
      controller.cancel();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pageshow", handlePageShow);
      unsubscribeControl();
      unsubscribeState();
      unsubscribeError();
      if (reconnectNowRef.current === reconnectNow) reconnectNowRef.current = null;
      if (relayRef.current === relay) relayRef.current = null;
      relay.close();
    };
  }, [identity, onAllEndpointsOffline, onControl, onRetryFinished, onSessionDisconnect, ready, relayUrl, setConnection, setConnectionFeedback]);

  useEffect(() => {
    const relay = relayRef.current;
    if (!relay || relay.state !== "open") return;
    relay.subscribeEndpoints(devices.map((device) => device.deviceId));
  }, [devices]);

  const reconnectNow = useCallback(() => reconnectNowRef.current?.(), []);
  const resubscribe = useCallback(() => {
    const relay = relayRef.current;
    return Boolean(relay?.state === "open" && relay.subscribeEndpoints(devicesRef.current.map((device) => device.deviceId)));
  }, []);
  const closeIntentionally = useCallback((reason: string) => {
    const relay = relayRef.current;
    if (!relay) return;
    intentionalCloseRef.current = true;
    relay.close(1000, reason);
  }, []);

  return { relayRef, onlineRef, relayStatus, relayVersion, retryAttempt, generation, reconnectNow, resubscribe, closeIntentionally };
}
