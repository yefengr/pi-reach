import { StrictMode, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { renderPwa } from "@/test/browser/render";
import { PwaUiProvider } from "./pwa-ui-provider";
import { startQrCameraSession, QR_SAMPLE_MAX_DIMENSION, QR_SCAN_INTERVAL_MS } from "@/lib/pwa/qr-camera";
import { decodeQrImage } from "@/lib/pwa/qr-decoder";
import { PairingDialog } from "./pairing-dialog";
import { QrCamera } from "./qr-scanner";
import type { PairingErrorCode } from "@/lib/pwa/use-device-pairing";

vi.mock("@/lib/pwa/qr-decoder", () => ({ decodeQrImage: vi.fn(() => null) }));

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const desktopUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36";
const mobileUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 Version/18.3 Mobile/15E148 Safari/604.1";
const cleanups: (() => void)[] = [];
let camera: Deferred<MediaStream>;

function useMobileNavigator() {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(mobileUserAgent);
  vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(5);
}

function createStream() {
  const stream = new MediaStream();
  const stops = [vi.fn(), vi.fn()];
  vi.spyOn(stream, "getTracks").mockReturnValue(stops.map((stop) => ({ stop }) as unknown as MediaStreamTrack));
  return { stream, stops };
}

function directSession(video = document.createElement("video")) {
  const onScan = vi.fn();
  const onUnavailable = vi.fn();
  const onUnreadable = vi.fn();
  const stop = startQrCameraSession({ video, onScan, onUnavailable, onUnreadable });
  cleanups.push(stop);
  return { video, stop, onScan, onUnavailable, onUnreadable };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

type DialogHarnessProps = {
  onSubmit?: (value: string) => void;
  onClose?: () => void;
  connecting?: boolean;
  error?: PairingErrorCode | null;
};
function PairingDialogHarness({ onSubmit = vi.fn(), onClose = vi.fn(), connecting = false, error = null }: DialogHarnessProps) {
  const [opened, setOpened] = useState(true);
  return <>
    <button onClick={() => setOpened(true)}>Reopen pairing</button>
    <PairingDialog opened={opened} connecting={connecting} error={error} onSubmit={onSubmit} onClearError={() => {}} onClose={() => { onClose(); setOpened(false); }} withinPortal={false} />
  </>;
}

beforeEach(async () => {
  camera = deferred<MediaStream>();
  vi.mocked(decodeQrImage).mockReset().mockReturnValue(null);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(desktopUserAgent);
  vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(0);
  vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(() => camera.promise);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(1920);
  vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(1080);
  vi.spyOn(CanvasRenderingContext2D.prototype, "drawImage").mockImplementation(() => {});
  await page.viewport(1280, 900);
});

afterEach(async () => {
  cleanups.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
  vi.restoreAllMocks();
  await page.viewport(1280, 900);
});

test("the camera starts with the expected video constraints and null frames are normal", async () => {
  const onUnavailable = vi.fn();
  const screen = await renderPwa(<QrCamera onScan={vi.fn()} onUnavailable={onUnavailable} />);
  await expect.poll(() => navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: false, video: { facingMode: { ideal: "environment" } } });
  const video = document.querySelector("video")!;
  expect(video.muted).toBe(true);
  expect(video.playsInline).toBe(true);
  await expect.element(screen.getByRole("region", { name: "Scan pairing QR code" })).toBeVisible();
  camera.resolve(createStream().stream);
  await expect.poll(() => decodeQrImage).toHaveBeenCalled();
  await expect.element(screen.getByText("Could not read this QR code.")).not.toBeInTheDocument();
  expect(onUnavailable).not.toHaveBeenCalled();
  vi.mocked(decodeQrImage).mockImplementation(() => { throw new Error("unreadable frame"); });
  await expect.element(screen.getByText("Could not read this QR code.")).toBeVisible();
  expect(onUnavailable).not.toHaveBeenCalled();
  await screen.unmount();
});

test("first result stops every track before the single callback and removes scheduling/listeners", async () => {
  vi.useFakeTimers();
  const remove = vi.spyOn(document, "removeEventListener");
  const owned = createStream();
  const session = directSession();
  session.onScan.mockImplementation(() => owned.stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1)));
  camera.resolve(owned.stream);
  await settle();
  vi.mocked(decodeQrImage).mockReturnValue("camera-first");
  await vi.advanceTimersByTimeAsync(QR_SCAN_INTERVAL_MS * 4);
  expect(session.onScan).toHaveBeenCalledExactlyOnceWith("camera-first");
  expect(session.video.srcObject).toBeNull();
  expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
  session.stop();
  owned.stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
});

test.each(["resolve", "reject"] as const)("permission late %s is silent after cleanup", async (outcome) => {
  const session = directSession();
  const owned = createStream();
  session.stop();
  if (outcome === "resolve") camera.resolve(owned.stream);
  else camera.reject(new Error("late denial"));
  await settle();
  expect(session.onScan).not.toHaveBeenCalled();
  expect(session.onUnavailable).not.toHaveBeenCalled();
  expect(session.video.srcObject).toBeNull();
  owned.stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(outcome === "resolve" ? 1 : 0));
});

test("active permission rejection calls unavailable once", async () => {
  const session = directSession();
  camera.reject(new Error("denied"));
  await settle();
  expect(session.onUnavailable).toHaveBeenCalledTimes(1);
  expect(session.onScan).not.toHaveBeenCalled();
});

test.each(["resolve", "reject"] as const)("late play %s cannot detach or restart a newer session", async (outcome) => {
  vi.useFakeTimers();
  const play = deferred<void>();
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => play.promise);
  const first = directSession();
  const oldStream = createStream();
  camera.resolve(oldStream.stream);
  await settle();
  first.stop();
  camera = deferred<MediaStream>();
  const second = directSession(first.video);
  const newStream = createStream();
  camera.resolve(newStream.stream);
  await settle();
  if (outcome === "resolve") play.resolve();
  else play.reject(new Error("old play failed"));
  await settle();
  expect(second.video.srcObject).toBe(newStream.stream);
  await vi.advanceTimersByTimeAsync(QR_SCAN_INTERVAL_MS);
  expect(decodeQrImage).toHaveBeenCalledTimes(1);
  expect(first.onUnavailable).not.toHaveBeenCalled();
  expect(first.onScan).not.toHaveBeenCalled();
  oldStream.stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
  newStream.stops.forEach((stop) => expect(stop).not.toHaveBeenCalled());
});

test("active play failure releases tracks and reports unavailable", async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new Error("cannot play"));
  const owned = createStream();
  const session = directSession();
  camera.resolve(owned.stream);
  await settle();
  expect(session.onUnavailable).toHaveBeenCalledTimes(1);
  owned.stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
  expect(session.video.srcObject).toBeNull();
});

test("reuses one bounded canvas, limits sampling, pauses when hidden and cancels on cleanup", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const create = vi.spyOn(document, "createElement");
  const session = directSession();
  camera.resolve(createStream().stream);
  await settle();
  await vi.advanceTimersByTimeAsync(QR_SCAN_INTERVAL_MS - 1);
  expect(decodeQrImage).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1 + QR_SCAN_INTERVAL_MS * 2);
  expect(decodeQrImage).toHaveBeenCalledTimes(3);
  const images = vi.mocked(decodeQrImage).mock.calls.map(([image]) => image);
  expect(images.every(({ width, height }) => width === QR_SAMPLE_MAX_DIMENSION && height === 360)).toBe(true);
  expect(create.mock.calls.filter(([tag]) => tag === "canvas")).toHaveLength(1);
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(QR_SCAN_INTERVAL_MS * 4);
  expect(decodeQrImage).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(QR_SCAN_INTERVAL_MS);
  expect(decodeQrImage).toHaveBeenCalledTimes(4);
  session.stop();
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(QR_SCAN_INTERVAL_MS * 2);
  expect(decodeQrImage).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
});

test("StrictMode late permission cleans only its own stream and live callbacks stay fresh", async () => {
  const requests = [deferred<MediaStream>(), deferred<MediaStream>()];
  vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(() => requests[0].promise).mockImplementationOnce(() => requests[1].promise);
  const initial = vi.fn();
  const latest = vi.fn();
  function Harness() {
    const [changed, setChanged] = useState(false);
    return <><button onClick={() => setChanged(true)}>Update callback</button><QrCamera onScan={changed ? latest : initial} onUnavailable={vi.fn()} /></>;
  }
  const screen = await render(<StrictMode><PwaUiProvider><div className="pwa-root"><Harness /></div></PwaUiProvider></StrictMode>);
  await expect.poll(() => navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
  const current = createStream();
  requests[1].resolve(current.stream);
  await expect.poll(() => document.querySelector("video")?.srcObject).toBe(current.stream);
  const stale = createStream();
  requests[0].resolve(stale.stream);
  await expect.poll(() => stale.stops[0]).toHaveBeenCalledTimes(1);
  expect(document.querySelector("video")?.srcObject).toBe(current.stream);
  await screen.getByRole("button", { name: "Update callback" }).click();
  vi.mocked(decodeQrImage).mockReturnValue("latest");
  await expect.poll(() => latest).toHaveBeenCalledExactlyOnceWith("latest");
  expect(initial).not.toHaveBeenCalled();
  await screen.unmount();
  current.stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
});

test("desktop starts only on request, preserves manual entry and stops when switching back", async () => {
  const onSubmit = vi.fn();
  const screen = await renderPwa(<PairingDialogHarness onSubmit={onSubmit} />);
  const input = screen.getByRole("textbox", { name: "Pairing code" });
  await expect.element(input).toBeVisible();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  await input.fill("k7mp 4q2");
  await expect.element(input).toHaveValue("K7MP 4Q2");
  expect(onSubmit).not.toHaveBeenCalled();
  await input.fill("k7mp-4q2d");
  expect(onSubmit).toHaveBeenCalledWith("K7MP-4Q2D");
  await screen.getByRole("button", { name: "Scan QR code" }).click();
  await expect.poll(() => navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  const owned = createStream();
  camera.resolve(owned.stream);
  await expect.poll(() => document.querySelector("video")?.srcObject).toBe(owned.stream);
  await screen.getByRole("button", { name: "Enter pairing code" }).click();
  await expect.element(input).toBeVisible();
  owned.stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
});

test("mobile falls back on denied permission and fills the first scanned code", async () => {
  useMobileNavigator();
  const onSubmit = vi.fn();
  const screen = await renderPwa(<PairingDialogHarness onSubmit={onSubmit} />);
  await expect.poll(() => navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  camera.reject(new Error("denied"));
  await expect.element(screen.getByText("The camera is unavailable. Enter the pairing code instead.")).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Pairing code" })).toBeVisible();
  camera = deferred<MediaStream>();
  await screen.getByRole("button", { name: "Scan QR code" }).click();
  vi.mocked(decodeQrImage).mockReturnValue("k7mp-4q2d");
  camera.resolve(createStream().stream);
  await expect.element(screen.getByRole("textbox", { name: "Pairing code" })).toHaveValue("K7MP-4Q2D");
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith("k7mp-4q2d");
});

test("shows failure under the input, keeps its value and disables the form while connecting", async () => {
  const onSubmit = vi.fn();
  function Harness() {
    const [error, setError] = useState<PairingErrorCode | null>(null);
    const [connecting, setConnecting] = useState(false);
    return <>
      <button onClick={() => setConnecting(true)}>Start connecting</button>
      <button onClick={() => { setConnecting(false); setError("expired_code"); }}>Fail</button>
      <PairingDialog opened connecting={connecting} error={error} onSubmit={onSubmit} onClearError={() => setError(null)} onClose={() => {}} withinPortal={false} />
    </>;
  }
  const screen = await renderPwa(<Harness />);
  const input = screen.getByRole("textbox", { name: "Pairing code" });
  await input.fill("K7MP-4Q2D");
  (screen.getByRole("button", { name: "Start connecting" }).element() as HTMLButtonElement).click();
  await expect.element(screen.getByText("Connecting to your computer…")).toBeVisible();
  await expect.element(input).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Pair", exact: true })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Scan QR code" })).toBeDisabled();
  (screen.getByRole("button", { name: "Fail" }).element() as HTMLButtonElement).click();
  await expect.element(screen.getByText("This pairing code has expired. Run /pi-reach pair in Pi again.")).toBeVisible();
  await expect.element(input).toHaveAttribute("aria-invalid", "true");
  await expect.element(input).toHaveValue("K7MP-4Q2D");
  await expect.element(input).toHaveFocus();
  await input.fill("K7MP-4Q2");
  await expect.element(screen.getByText("This pairing code has expired. Run /pi-reach pair in Pi again.")).not.toBeInTheDocument();
});

test("mobile controls remain reachable and close/reopen ignores old permission", async () => {
  useMobileNavigator();
  await page.viewport(390, 844);
  const oldRequest = camera;
  const onClose = vi.fn();
  const screen = await renderPwa(<PairingDialogHarness onClose={onClose} />);
  await expect.poll(() => navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  const rect = document.querySelector<HTMLElement>(".pwa-pairing-dialog")!.getBoundingClientRect();
  expect(Math.round(rect.left)).toBeGreaterThanOrEqual(16);
  expect(Math.round(rect.right)).toBeLessThanOrEqual(window.innerWidth - 16);
  for (const name of ["Close pairing", "Enter pairing code"]) {
    expect(screen.getByRole("button", { name }).element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  }
  await screen.getByRole("button", { name: "Close pairing" }).click();
  await expect.poll(() => document.querySelector(".pwa-scanner")).toBeNull();
  expect(onClose).toHaveBeenCalledTimes(1);
  camera = deferred<MediaStream>();
  await screen.getByRole("button", { name: "Reopen pairing" }).click();
  await expect.poll(() => navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
  const current = createStream();
  camera.resolve(current.stream);
  await expect.poll(() => document.querySelector("video")?.srcObject).toBe(current.stream);
  const stale = createStream();
  oldRequest.resolve(stale.stream);
  await expect.poll(() => stale.stops[0]).toHaveBeenCalledTimes(1);
  expect(document.querySelector("video")?.srcObject).toBe(current.stream);
  await screen.unmount();
  current.stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
});
