import { decodeQrImage } from "./qr-decoder";

export const QR_SAMPLE_MAX_DIMENSION = 640;
export const QR_SCAN_INTERVAL_MS = 200;

type CameraSessionOptions = {
  video: HTMLVideoElement;
  onScan: (value: string) => void;
  onUnavailable: () => void;
  onUnreadable: () => void;
};

/** 每轮 effect 独占流、画布与调度；异步返回只可处理本轮资源。 */
export function startQrCameraSession({ video, onScan, onUnavailable, onUnreadable }: CameraSessionOptions): () => void {
  let active = true;
  let playing = false;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  function cancelTimer() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function stop() {
    if (!active) return;
    active = false;
    cancelTimer();
    document.removeEventListener("visibilitychange", visibilityChanged);
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    // 旧 play/权限 promise 的清理不能摘掉新一轮已挂载的流。
    if (video.srcObject === stream) {
      video.pause();
      video.srcObject = null;
    }
    stream = null;
  }

  function schedule() {
    if (!active || !playing || document.hidden || timer !== null) return;
    timer = setTimeout(scan, QR_SCAN_INTERVAL_MS);
  }

  function scan() {
    timer = null;
    if (!active || document.hidden) return;
    if (context && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
      const scale = Math.min(1, QR_SAMPLE_MAX_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      let result: string | null = null;
      try {
        context.drawImage(video, 0, 0, width, height);
        result = decodeQrImage(context.getImageData(0, 0, width, height));
      } catch {
        onUnreadable();
      }
      if (result) {
        stop();
        onScan(result);
        return;
      }
    }
    schedule();
  }

  function visibilityChanged() {
    if (document.hidden) cancelTimer();
    else schedule();
  }

  async function start() {
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" } } });
      if (!active) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      if (!context) throw new Error("Camera canvas unavailable");
      video.srcObject = acquired;
      await video.play();
      if (!active) return;
      playing = true;
      schedule();
    } catch {
      if (!active) return;
      stop();
      onUnavailable();
    }
  }

  document.addEventListener("visibilitychange", visibilityChanged);
  void start();
  return stop;
}
