import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { startQrCameraSession } from "@/lib/pwa/qr-camera";

/** 浏览器是否提供摄像头接口；实际权限在切换到扫码时才请求。 */
export function cameraSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

type QrCameraProps = {
  onScan: (value: string) => void;
  /** 摄像头无法启动或被拒绝时调用，由上层切回手动输入并说明原因。 */
  onUnavailable: () => void;
};

/**
 * 扫码取景：挂载时才请求摄像头，卸载时释放。首个识别结果生效，之后的结果忽略。
 */
export function QrCamera({ onScan, onUnavailable }: QrCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onScanRef = useRef(onScan);
  const onUnavailableRef = useRef(onUnavailable);
  const { t } = useI18n();
  const [unreadable, setUnreadable] = useState(false);

  useEffect(() => {
    onScanRef.current = onScan;
    onUnavailableRef.current = onUnavailable;
  }, [onScan, onUnavailable]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    return startQrCameraSession({
      video,
      onScan: (value) => onScanRef.current(value),
      onUnavailable: () => onUnavailableRef.current(),
      onUnreadable: () => setUnreadable(true),
    });
  }, []);

  return <section className="pwa-scanner" aria-label={t.pairing.scanLabel}>
    <div className="pwa-scanner-frame">
      <video ref={videoRef} muted playsInline />
      <span className="pwa-scan-corner pwa-scan-corner-tl" />
      <span className="pwa-scan-corner pwa-scan-corner-tr" />
      <span className="pwa-scan-corner pwa-scan-corner-bl" />
      <span className="pwa-scan-corner pwa-scan-corner-br" />
    </div>
    <p className="pwa-pairing-hint">{t.pairing.scanHint}</p>
    {unreadable ? <p className="pwa-pairing-error" role="alert">{t.pairing.unreadableQr}</p> : null}
  </section>;
}
