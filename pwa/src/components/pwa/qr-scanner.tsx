import { useEffect, useRef, useState } from "react";
import { Button, FileButton } from "@mantine/core";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import { ImageUp } from "lucide-react";
import { useI18n } from "@/lib/i18n";

function stopControls(controls: IScannerControls | null, stoppedControls: WeakSet<IScannerControls>) {
  if (!controls || stoppedControls.has(controls)) return;
  stoppedControls.add(controls);
  controls.stop();
}

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
  const controlsRef = useRef<IScannerControls | null>(null);
  const onScanRef = useRef(onScan);
  const onUnavailableRef = useRef(onUnavailable);
  const { t } = useI18n();
  const [unreadable, setUnreadable] = useState(false);

  useEffect(() => {
    onScanRef.current = onScan;
    onUnavailableRef.current = onUnavailable;
  }, [onScan, onUnavailable]);

  useEffect(() => {
    const state = { active: true, claimed: false };
    const stoppedControls = new WeakSet<IScannerControls>();
    const handleControls = (controls: IScannerControls) => {
      if (!state.active || state.claimed) {
        stopControls(controls, stoppedControls);
        return false;
      }
      controlsRef.current = controls;
      return true;
    };
    void new BrowserQRCodeReader()
      .decodeFromConstraints(
        { audio: false, video: { facingMode: { ideal: "environment" } } },
        videoRef.current ?? undefined,
        (result, decodeError, controls) => {
          if (!handleControls(controls)) return;
          if (result) {
            if (state.claimed) return;
            state.claimed = true;
            stopControls(controlsRef.current, stoppedControls);
            onScanRef.current(result.getText());
            return;
          }
          if (decodeError && decodeError.name !== "NotFoundException" && state.active && !state.claimed) setUnreadable(true);
        },
      )
      .then((controls) => { handleControls(controls); })
      .catch(() => { if (state.active && !state.claimed) onUnavailableRef.current(); });
    return () => {
      state.active = false;
      stopControls(controlsRef.current, stoppedControls);
      controlsRef.current = null;
    };
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

type QrImageButtonProps = {
  onScan: (value: string) => void;
  onNotFound: () => void;
  disabled?: boolean;
};

/** 上传二维码图片：解码成功交给 onScan，失败时 onNotFound；卸载后到达的结果忽略。 */
export function QrImageButton({ onScan, onNotFound, disabled = false }: QrImageButtonProps) {
  const { t } = useI18n();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const scanImage = async (file: File | null) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    let text: string;
    try {
      text = (await new BrowserQRCodeReader().decodeFromImageUrl(url)).getText();
    } catch {
      if (mountedRef.current) onNotFound();
      return;
    } finally {
      URL.revokeObjectURL(url);
    }
    if (mountedRef.current) onScan(text);
  };
  return <FileButton accept="image/*" inputProps={{ className: "pwa-file-input", hidden: true }} onChange={(file) => void scanImage(file)} disabled={disabled}>
    {({ onClick }) => <Button className="pwa-pairing-method" variant="transparent" color="piReach" type="button" leftSection={<ImageUp size={16} aria-hidden="true" />} onClick={onClick} disabled={disabled}>{t.pairing.uploadQr}</Button>}
  </FileButton>;
}
