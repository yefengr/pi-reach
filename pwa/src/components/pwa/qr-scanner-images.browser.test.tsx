import { afterEach, expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { pairingQrFixtures } from "@/test/fixtures/pairing-qr";
import { pairingQrImage } from "@/test/qr-image";
import { QR_SAMPLE_MAX_DIMENSION } from "@/lib/pwa/qr-camera";
import { PairingDialog } from "./pairing-dialog";

const cases = ["light", "dark"].flatMap((scheme) => [24, 255].map((background) => ({ scheme, background })));

afterEach(() => {
  vi.restoreAllMocks();
});

// 不 mock jsQR、canvas、video 或播放；只有摄像头来源替换为固定合成图像流。
// 桌面 Chromium 的这条真实媒体链路不代表手机相机验收。
test.each(cases)("real video fills and submits once in $scheme PWA on terminal background $background", async ({ scheme, background }) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 Version/18.3 Mobile/15E148 Safari/604.1");
  vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(5);
  const fixture = pairingQrFixtures[0];
  const image = pairingQrImage(fixture.modules, { scale: 16, background, rotation: 7, shear: 0.06 });
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d")!.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  // 真实视频帧必须跨过采样上限，避免只验证无需降采样的小图。
  expect(Math.max(canvas.width, canvas.height)).toBeGreaterThan(QR_SAMPLE_MAX_DIMENSION);
  const stream = canvas.captureStream(10);
  const tracks = stream.getTracks();
  const stops = tracks.map((track) => vi.spyOn(track, "stop"));
  let grant!: (value: MediaStream) => void;
  vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(() => new Promise<MediaStream>((resolve) => { grant = resolve; }));
  const onSubmit = vi.fn();
  const previousScheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  const screen = await renderPwa(<PairingDialog opened connecting={false} error={null} onSubmit={onSubmit} onClearError={() => {}} onClose={() => {}} withinPortal={false} />);
  try {
    document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
    await expect.poll(() => navigator.mediaDevices.getUserMedia, { timeout: 5_000 }).toHaveBeenCalledTimes(1);
    const video = document.querySelector(".pwa-scanner video") as HTMLVideoElement;
    expect(video).toBeInstanceOf(HTMLVideoElement);
    grant(stream);
    await expect.element(screen.getByRole("textbox", { name: "Pairing code" }), { timeout: 5_000 }).toHaveValue(fixture.code);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(fixture.code);
    expect(video.srcObject).toBeNull();
    stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
    expect(tracks.every((track) => track.readyState === "ended")).toBe(true);
    await expect.poll(() => document.querySelector(".pwa-scanner"), { timeout: 5_000 }).toBeNull();
    // 触发可见性变化也不能把首结果已完成的会话重新调度。
    document.dispatchEvent(new Event("visibilitychange"));
    await screen.unmount();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  } finally {
    await screen.unmount();
    tracks.forEach((track) => { if (track.readyState !== "ended") track.stop(); });
    if (previousScheme === null) document.documentElement.removeAttribute("data-mantine-color-scheme");
    else document.documentElement.setAttribute("data-mantine-color-scheme", previousScheme);
  }
});
