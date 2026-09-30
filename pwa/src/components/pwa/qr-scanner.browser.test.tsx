import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { PairingDialog } from "./pairing-dialog";
import { QrCamera, QrImageButton } from "./qr-scanner";
import type { PairingErrorCode } from "@/lib/pwa/use-device-pairing";
import type { IScannerControls } from "@zxing/browser";

type ScannerResult = { getText: () => string };
type ScannerError = { name: string };
type ScannerCallback = (result: ScannerResult | undefined, error: ScannerError | undefined, controls: IScannerControls) => void;
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};
type CameraCall = {
  constraints: MediaStreamConstraints;
  video: HTMLVideoElement | undefined;
  callback: ScannerCallback;
};
type CameraMock = {
  deferred: Deferred<IScannerControls>;
  calls: CameraCall[];
};
type ImageMock = {
  deferred: Deferred<ScannerResult>;
  urls: string[];
};
type MockReader = {
  decodeFromConstraints: ReturnType<typeof vi.fn>;
  decodeFromImageUrl: ReturnType<typeof vi.fn>;
};

const desktopUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36";
const mobileUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 Version/18.3 Mobile/15E148 Safari/604.1";

const zxing = vi.hoisted(() => {
  const state: {
    camera: CameraMock | null;
    image: ImageMock | null;
    instances: MockReader[];
  } = { camera: null, image: null, instances: [] };
  const BrowserQRCodeReader = vi.fn(function MockBrowserQRCodeReader(this: MockReader) {
    this.decodeFromConstraints = vi.fn((constraints: MediaStreamConstraints, video: HTMLVideoElement | undefined, callback: ScannerCallback) => {
      state.camera?.calls.push({ constraints, video, callback });
      return state.camera?.deferred.promise ?? new Promise<IScannerControls>(() => {});
    });
    this.decodeFromImageUrl = vi.fn((url: string) => {
      state.image?.urls.push(url);
      return state.image?.deferred.promise ?? Promise.resolve({ getText: () => "unused" });
    });
    state.instances.push(this);
  });

  return { BrowserQRCodeReader, state };
});

vi.mock("@zxing/browser", () => ({ BrowserQRCodeReader: zxing.BrowserQRCodeReader }));

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mockNavigator(userAgent: string, maxTouchPoints = 0) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(maxTouchPoints);
}

function useMobileNavigator() {
  mockNavigator(mobileUserAgent, 5);
}

function prepareCamera() {
  const camera: CameraMock = { deferred: createDeferred<IScannerControls>(), calls: [] };
  zxing.state.camera = camera;
  return camera;
}

function prepareImage() {
  const image: ImageMock = { deferred: createDeferred<ScannerResult>(), urls: [] };
  zxing.state.image = image;
  return image;
}

function createControls() {
  return { stop: vi.fn() } as IScannerControls;
}

function createResult(value: string): ScannerResult {
  return { getText: () => value };
}

function emitCameraResult(camera: CameraMock, controls: IScannerControls, result?: ScannerResult, error?: ScannerError) {
  expect(camera.calls).toHaveLength(1);
  camera.calls[0].callback(result, error, controls);
}

type DialogHarnessProps = {
  onSubmit?: (value: string) => void;
  onClose?: () => void;
  connecting?: boolean;
  error?: PairingErrorCode | null;
};

function PairingDialogHarness({ onSubmit = vi.fn(), onClose = vi.fn(), connecting = false, error = null }: DialogHarnessProps) {
  const [opened, setOpened] = useState(true);
  return <PairingDialog opened={opened} connecting={connecting} error={error} onSubmit={onSubmit} onClearError={() => {}} onClose={() => { onClose(); setOpened(false); }} withinPortal={false} />;
}

function UnmountableCamera({ onScan = vi.fn(), onUnavailable = vi.fn() }: { onScan?: (value: string) => void; onUnavailable?: () => void }) {
  const [open, setOpen] = useState(true);
  return <>
    <button type="button" onClick={() => setOpen(false)}>Unmount scanner</button>
    {open ? <QrCamera onScan={onScan} onUnavailable={onUnavailable} /> : null}
  </>;
}

function UnmountableImageButton({ onScan = vi.fn(), onNotFound = vi.fn() }: { onScan?: (value: string) => void; onNotFound?: () => void }) {
  const [open, setOpen] = useState(true);
  return <>
    <button type="button" onClick={() => setOpen(false)}>Unmount upload</button>
    {open ? <QrImageButton onScan={onScan} onNotFound={onNotFound} /> : null}
  </>;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function selectImage(input: HTMLInputElement, fileName = "qr.png") {
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["image"], fileName, { type: "image/png" })],
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  return input!;
}

beforeEach(async () => {
  zxing.BrowserQRCodeReader.mockClear();
  zxing.state.instances.length = 0;
  zxing.state.camera = null;
  zxing.state.image = null;
  mockNavigator(desktopUserAgent);
  await page.viewport(1280, 900);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await page.viewport(1280, 900);
});

test("the camera starts with the expected video element on mount and reports unreadable codes", async () => {
  const camera = prepareCamera();
  const screen = await renderPwa(<QrCamera onScan={vi.fn()} onUnavailable={vi.fn()} />);
  await expect.poll(() => camera.calls).toHaveLength(1);

  const [{ constraints, video }] = camera.calls;
  expect(constraints).toEqual({ audio: false, video: { facingMode: { ideal: "environment" } } });
  expect(video).toBeInstanceOf(HTMLVideoElement);
  expect(video?.muted).toBe(true);
  expect(video?.playsInline).toBe(true);
  await expect.element(screen.getByRole("region", { name: "Scan pairing QR code" })).toBeVisible();

  const controls = createControls();
  emitCameraResult(camera, controls, undefined, { name: "NotFoundException" });
  await expect.element(screen.getByText("Could not read this QR code.")).not.toBeInTheDocument();
  emitCameraResult(camera, controls, undefined, { name: "ChecksumException" });
  await expect.element(screen.getByText("Could not read this QR code.")).toBeVisible();
});

test("the first camera result wins once and stops the camera", async () => {
  const camera = prepareCamera();
  const onScan = vi.fn();
  await renderPwa(<QrCamera onScan={onScan} onUnavailable={vi.fn()} />);
  await expect.poll(() => camera.calls).toHaveLength(1);
  const controls = createControls();

  emitCameraResult(camera, controls, createResult("camera-first"));
  expect(controls.stop).toHaveBeenCalledTimes(1);
  expect(onScan).toHaveBeenCalledWith("camera-first");
  emitCameraResult(camera, controls, createResult("camera-later"));
  expect(onScan).toHaveBeenCalledTimes(1);
});

test("reports camera startup failure only while mounted", async () => {
  const camera = prepareCamera();
  const onUnavailable = vi.fn();
  await renderPwa(<QrCamera onScan={vi.fn()} onUnavailable={onUnavailable} />);
  await expect.poll(() => camera.calls).toHaveLength(1);
  camera.deferred.reject(new Error("camera denied"));
  await expect.poll(() => onUnavailable).toHaveBeenCalledTimes(1);

  const lateCamera = prepareCamera();
  const lateUnavailable = vi.fn();
  const lateScreen = await renderPwa(<UnmountableCamera onUnavailable={lateUnavailable} />);
  await expect.poll(() => lateCamera.calls).toHaveLength(1);
  await lateScreen.getByRole("button", { name: "Unmount scanner" }).click();
  lateCamera.deferred.reject(new Error("late camera denied"));
  await settle();
  expect(lateUnavailable).not.toHaveBeenCalled();
});

test("stops camera controls that resolve after the scanner unmounts", async () => {
  const camera = prepareCamera();
  const controls = createControls();
  const screen = await renderPwa(<UnmountableCamera />);
  await expect.poll(() => camera.calls).toHaveLength(1);

  await screen.getByRole("button", { name: "Unmount scanner" }).click();
  camera.deferred.resolve(controls);
  await expect.poll(() => controls.stop).toHaveBeenCalledTimes(1);
});

test("scans a chosen image through the keyboard-operable upload button and never starts a camera", async () => {
  const camera = prepareCamera();
  const image = prepareImage();
  const onScan = vi.fn();
  const screen = await renderPwa(<QrImageButton onScan={onScan} onNotFound={vi.fn()} />);
  const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chosen-qr");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
  const input = fileInput();

  expect(input.hidden).toBe(true);
  expect(input.accept).toBe("image/*");
  expect(input.hasAttribute("capture")).toBe(false);
  let chooserOpens = 0;
  input.addEventListener("click", (event) => {
    event.preventDefault();
    chooserOpens += 1;
  });
  const upload = screen.getByRole("button", { name: "Upload QR image" });
  upload.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(chooserOpens).toBe(1);
  input.dispatchEvent(new Event("cancel", { bubbles: true }));
  input.files = new DataTransfer().files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(onScan).not.toHaveBeenCalled();
  await expect.element(upload).toHaveFocus();

  selectImage(input);
  await expect.poll(() => image.urls).toEqual(["blob:chosen-qr"]);
  image.deferred.resolve(createResult("image-first"));
  await expect.poll(() => onScan).toHaveBeenCalledWith("image-first");
  expect(camera.calls).toHaveLength(0);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:chosen-qr");
});

test("reports image decode failures and ignores results that arrive after unmount", async () => {
  const image = prepareImage();
  const onNotFound = vi.fn();
  await renderPwa(<QrImageButton onScan={vi.fn()} onNotFound={onNotFound} />);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:bad-qr");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
  selectImage(fileInput(), "bad.png");
  await expect.poll(() => image.urls).toEqual(["blob:bad-qr"]);
  image.deferred.reject(new Error("invalid image"));
  await expect.poll(() => onNotFound).toHaveBeenCalledTimes(1);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:bad-qr");

  const lateImage = prepareImage();
  const onScan = vi.fn();
  document.body.replaceChildren();
  const screen = await renderPwa(<UnmountableImageButton onScan={onScan} />);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:late-qr");
  selectImage(fileInput());
  await expect.poll(() => lateImage.urls).toEqual(["blob:late-qr"]);
  await screen.getByRole("button", { name: "Unmount upload" }).click();
  lateImage.deferred.resolve(createResult("late-image"));
  await expect.poll(() => revokeObjectURL).toHaveBeenCalledWith("blob:late-qr");
  expect(onScan).not.toHaveBeenCalled();
});

test("desktop opens with the pairing code, auto-submits eight characters and starts the camera only on request", async () => {
  const camera = prepareCamera();
  const onSubmit = vi.fn();
  const screen = await renderPwa(<PairingDialogHarness onSubmit={onSubmit} />);
  const input = screen.getByRole("textbox", { name: "Pairing code" });
  await expect.element(input).toBeVisible();
  await settle();
  expect(camera.calls).toHaveLength(0);

  await input.fill("k7mp 4q2");
  await expect.element(input).toHaveValue("K7MP 4Q2");
  expect(onSubmit).not.toHaveBeenCalled();
  await input.fill("k7mp-4q2d");
  await expect.element(input).toHaveValue("K7MP-4Q2D");
  expect(onSubmit).toHaveBeenCalledWith("K7MP-4Q2D");

  await screen.getByRole("button", { name: "Scan QR code" }).click();
  await expect.poll(() => camera.calls).toHaveLength(1);
  const controls = createControls();
  camera.deferred.resolve(controls);
  await settle();
  await screen.getByRole("button", { name: "Enter pairing code" }).click();
  await expect.element(screen.getByRole("textbox", { name: "Pairing code" })).toBeVisible();
  expect(controls.stop).toHaveBeenCalledTimes(1);
});

test("mobile opens with the camera, falls back to the code when it is unavailable, and fills scanned codes", async () => {
  useMobileNavigator();
  let camera = prepareCamera();
  const onSubmit = vi.fn();
  const screen = await renderPwa(<PairingDialogHarness onSubmit={onSubmit} />);
  await expect.poll(() => camera.calls).toHaveLength(1);
  camera.deferred.reject(new Error("denied"));
  await expect.element(screen.getByText("The camera is unavailable. Enter the pairing code instead.")).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Pairing code" })).toBeVisible();

  camera = prepareCamera();
  await screen.getByRole("button", { name: "Scan QR code" }).click();
  await expect.poll(() => camera.calls).toHaveLength(1);
  emitCameraResult(camera, createControls(), createResult("k7mp-4q2d"));
  await expect.element(screen.getByRole("textbox", { name: "Pairing code" })).toHaveValue("K7MP-4Q2D");
  expect(onSubmit).toHaveBeenCalledWith("k7mp-4q2d");
});

test("shows the failure under the input, keeps the value and disables the form while connecting", async () => {
  const onSubmit = vi.fn();
  function Harness() {
    const [error, setError] = useState<PairingErrorCode | null>(null);
    const [connecting, setConnecting] = useState(false);
    return <>
      <button type="button" onClick={() => setConnecting(true)}>Start connecting</button>
      <button type="button" onClick={() => { setConnecting(false); setError("expired_code"); }}>Fail</button>
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
  await expect.element(screen.getByRole("button", { name: "Upload QR image" })).toBeDisabled();

  (screen.getByRole("button", { name: "Fail" }).element() as HTMLButtonElement).click();
  await expect.element(screen.getByText("This pairing code has expired. Run /pi-reach pair in Pi again.")).toBeVisible();
  await expect.element(input).toHaveAttribute("aria-invalid", "true");
  await expect.element(input).toHaveValue("K7MP-4Q2D");
  await expect.element(input).toHaveFocus();
  await input.fill("K7MP-4Q2");
  await expect.element(screen.getByText("This pairing code has expired. Run /pi-reach pair in Pi again.")).not.toBeInTheDocument();
});

test("keeps pairing controls reachable at 390 by 844 and releases the camera when closed", async () => {
  useMobileNavigator();
  await page.viewport(390, 844);
  const camera = prepareCamera();
  const controls = createControls();
  const onClose = vi.fn();
  const screen = await renderPwa(<PairingDialogHarness onClose={onClose} />);
  await expect.poll(() => camera.calls).toHaveLength(1);
  camera.deferred.resolve(controls);
  await settle();
  const dialog = document.querySelector<HTMLElement>(".pwa-pairing-dialog")!;
  const rect = dialog.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(16);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth - 16);
  for (const name of ["Close pairing", "Enter pairing code", "Upload QR image"]) {
    const button = screen.getByRole("button", { name }).element();
    expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: "../../../.vitest/screenshots/pairing-scan-390.png" });

  await screen.getByRole("button", { name: "Close pairing" }).click();
  await expect.poll(() => document.querySelector(".pwa-scanner")).toBeNull();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(controls.stop).toHaveBeenCalledTimes(1);
});
