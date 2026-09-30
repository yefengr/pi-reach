import { useEffect, useRef, useState } from "react";
import { Button, Loader, Modal, TextInput } from "@mantine/core";
import { CircleAlert, Keyboard, ScanLine } from "lucide-react";
import { cameraSupported, QrCamera, QrImageButton } from "@/components/pwa/qr-scanner";
import { isPairingCameraDevice } from "@/lib/pwa/pairing-device";
import { normalizePairCode } from "@/lib/pi-reach/pairing";
import type { PairingErrorCode } from "@/lib/pwa/use-device-pairing";
import { useI18n } from "@/lib/i18n";

type PairingMode = "scan" | "code";
type LocalNotice = "cameraUnavailable" | "noQrFound";

type PairingDialogProps = {
  opened: boolean;
  connecting: boolean;
  error: PairingErrorCode | null;
  onSubmit: (code: string) => void;
  onClearError: () => void;
  onClose: () => void;
  focusOrigin?: HTMLElement | null;
  focusFallbackSelectors?: readonly string[];
  withinPortal?: boolean;
};

function canFocus(element: HTMLElement): boolean {
  return element !== document.body && element !== document.documentElement && element.isConnected && !element.matches(":disabled") && element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"], [inert]');
}

function defaultMode(): PairingMode {
  return typeof navigator !== "undefined" && isPairingCameraDevice(navigator) && cameraSupported() ? "scan" : "code";
}

/** 配对码只保留 Crockford Base32 字符以及分隔用的 `-` 与空格，并自动转大写。 */
function formatCodeInput(value: string): string {
  return value.toUpperCase().replace(/[^0-9A-Z\s-]/g, "");
}

/**
 * 配对弹窗（表单类 Modal，宽 480）：移动端默认扫码，桌面默认输入配对码，其余方式以文字按钮置于下方。
 * 输满 8 位有效字符自动提交；连接中输入与按钮暂不可用；失败原因显示在输入框下方并保留已输入内容。
 */
export function PairingDialog({ opened, connecting, error, onSubmit, onClearError, onClose, focusOrigin = null, focusFallbackSelectors = [], withinPortal = true }: PairingDialogProps) {
  const { t } = useI18n();
  const p = t.pairing;
  const [mode, setMode] = useState<PairingMode>(defaultMode);
  const [value, setValue] = useState("");
  const [notice, setNotice] = useState<LocalNotice | null>(null);
  const [wasOpened, setWasOpened] = useState(opened);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const focusOriginRef = useRef<HTMLElement | null>(focusOrigin);
  const focusFallbackSelectorsRef = useRef(focusFallbackSelectors);
  if (wasOpened !== opened) {
    setWasOpened(opened);
    if (opened) {
      setMode(defaultMode());
      setValue("");
      setNotice(null);
    }
  }

  useEffect(() => {
    focusFallbackSelectorsRef.current = focusFallbackSelectors;
  }, [focusFallbackSelectors]);
  useEffect(() => {
    if (opened) focusOriginRef.current = focusOrigin;
  }, [focusOrigin, opened]);
  useEffect(() => {
    // 失败后焦点回到输入框，便于改正后重试。
    if (error && opened && mode === "code") inputRef.current?.focus();
  }, [error, mode, opened]);

  const submit = (raw: string) => {
    setNotice(null);
    onSubmit(raw);
  };
  const receiveScan = (raw: string) => {
    // 扫描或上传得到的配对码回填到输入框，失败原因同样显示在输入框下方。
    setValue(formatCodeInput(raw).trim());
    setMode("code");
    submit(raw);
  };
  const changeValue = (next: string) => {
    const formatted = formatCodeInput(next);
    setValue(formatted);
    if (error) onClearError();
    setNotice(null);
    if (!connecting && normalizePairCode(formatted)) submit(formatted);
  };
  const restoreFocusAfterExit = () => {
    const dialog = dialogRef.current;
    let remainingFrames = 4;
    const restore = () => {
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (activeElement && canFocus(activeElement) && !dialog?.contains(activeElement)) return;
      const candidates = [
        focusOriginRef.current,
        ...focusFallbackSelectorsRef.current.map((selector) => document.querySelector<HTMLElement>(selector)),
      ];
      const focusTarget = candidates.find((candidate): candidate is HTMLElement => candidate !== null && canFocus(candidate));
      if (focusTarget) focusTarget.focus({ preventScroll: true });
      else if (remainingFrames > 0) {
        remainingFrames -= 1;
        requestAnimationFrame(restore);
      }
    };
    window.setTimeout(() => requestAnimationFrame(restore), 20);
  };

  const errorText = error ? p.errors[error] : notice === "noQrFound" ? p.noQrFound : null;
  const scanning = opened && mode === "scan" && !connecting;

  return <Modal
    ref={dialogRef}
    opened={opened}
    onClose={onClose}
    title={<span id="pwa-pairing-title" className="pwa-pairing-title">{p.dialogTitle}</span>}
    aria-labelledby="pwa-pairing-title"
    size={480}
    withinPortal={withinPortal}
    portalProps={{ target: ".pwa-root" }}
    zIndex={300}
    trapFocus
    returnFocus
    lockScroll
    closeOnClickOutside={!connecting}
    closeOnEscape
    onExitTransitionEnd={restoreFocusAfterExit}
    closeButtonProps={{ "aria-label": p.close, title: p.close }}
    classNames={{ content: "pwa-pairing-dialog", header: "pwa-pairing-head", title: "pwa-pairing-title-wrap", close: "pwa-icon-button", body: "pwa-pairing-body" }}
  >
    <p className="pwa-pairing-description">{p.description}</p>
    {scanning ? <QrCamera onScan={receiveScan} onUnavailable={() => { setNotice("cameraUnavailable"); setMode("code"); }} /> : <form className="pwa-pairing-form" onSubmit={(event) => { event.preventDefault(); submit(value); }}>
      {notice === "cameraUnavailable" ? <p className="pwa-pairing-hint" role="status">{p.cameraUnavailable}</p> : null}
      <TextInput
        ref={inputRef}
        className="pwa-input pwa-pairing-input"
        label={p.codeLabel}
        description={errorText ? undefined : p.codeHint}
        error={errorText ? <span className="pwa-field-error"><CircleAlert size={16} aria-hidden="true" />{errorText}</span> : undefined}
        value={value}
        onChange={(event) => changeValue(event.target.value)}
        placeholder="K7MP-4Q2D"
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="one-time-code"
        spellCheck={false}
        disabled={connecting}
        data-autofocus
      />
      <Button type="submit" disabled={connecting || !value.trim()}>{p.submit}</Button>
    </form>}
    {connecting ? <p className="pwa-pairing-status" role="status"><Loader size={16} type="oval" color="var(--pwa-running)" aria-hidden="true" />{p.connecting}</p> : null}
    <div className="pwa-pairing-methods">
      {mode === "code"
        ? cameraSupported() ? <Button className="pwa-pairing-method" variant="transparent" color="piReach" type="button" leftSection={<ScanLine size={16} aria-hidden="true" />} disabled={connecting} onClick={() => { onClearError(); setNotice(null); setMode("scan"); }}>{p.scanQr}</Button> : null
        : <Button className="pwa-pairing-method" variant="transparent" color="piReach" type="button" leftSection={<Keyboard size={16} aria-hidden="true" />} disabled={connecting} onClick={() => setMode("code")}>{p.enterCode}</Button>}
      <QrImageButton disabled={connecting} onScan={receiveScan} onNotFound={() => { onClearError(); setMode("code"); setNotice("noQrFound"); }} />
    </div>
  </Modal>;
}
