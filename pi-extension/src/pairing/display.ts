import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderQRAscii, type PairingInvite } from "./qr.js";

export const PAIR_WIDGET_KEY = "pi-reach-pair-code";
// 设备名来自 PWA，只限制了协议长度；提示里截短，避免撑满终端。
const MAX_DEVICE_NAME_CHARS = 64;
const UNNAMED_DEVICE = "unnamed device";

type PairingUi = Pick<ExtensionContext["ui"], "notify" | "setWidget">;

type ShownInvite = {
  readonly ui: PairingUi;
  readonly code: string;
  readonly timer: ReturnType<typeof setTimeout>;
};

/** 去掉控制与格式字符，防止 Owner 自报的设备名向终端注入转义序列。 */
export function displayDeviceName(deviceName: string): string {
  const name = Array.from(deviceName.replace(/[\p{Cc}\p{Cf}]/gu, "").trim()).slice(0, MAX_DEVICE_NAME_CHARS).join("");
  return name || UNNAMED_DEVICE;
}

/**
 * 管理配对二维码 widget：配对成功、配对码过期或 Relay 关闭时收起。
 * 只负责界面；邀请状态仍由 QRSession 持有，成功后保留以便重放 pair_ok。
 */
export class PairingDisplay {
  private shown: ShownInvite | null = null;

  show(ui: PairingUi, invite: PairingInvite): void {
    this.hide();
    try {
      ui.setWidget(PAIR_WIDGET_KEY, [
        "Scan to pair:",
        "",
        renderQRAscii(invite.code),
        "",
        `Pairing code: ${invite.code}`,
        `Expires at: ${new Date(invite.expiresAt).toLocaleTimeString()}`,
      ]);
    } catch { /* headless pairing still has a status message */ }
    const timer = setTimeout(() => this.expire(invite.code), Math.max(0, invite.expiresAt - Date.now()));
    timer.unref?.();
    this.shown = { ui, code: invite.code, timer };
  }

  paired(code: string, deviceName: string): void {
    const shown = this.take(code);
    if (!shown) return;
    notify(shown.ui, `[pi-reach] Paired: ${displayDeviceName(deviceName)}`);
  }

  hide(): void {
    if (this.shown) this.take(this.shown.code);
  }

  private expire(code: string): void {
    const shown = this.take(code);
    if (shown) notify(shown.ui, "[pi-reach] Pairing code expired. Run /pi-reach pair again.");
  }

  /** 收起指定配对码的二维码；已被新配对码替换时返回 null，避免误收新二维码。 */
  private take(code: string): ShownInvite | null {
    const shown = this.shown;
    if (!shown || shown.code !== code) return null;
    this.shown = null;
    clearTimeout(shown.timer);
    try { shown.ui.setWidget(PAIR_WIDGET_KEY, undefined); } catch { /* stale UI context */ }
    return shown;
  }
}

function notify(ui: PairingUi, text: string): void {
  try { ui.notify(text, "info"); } catch { /* headless or stale context */ }
}

export const pairingDisplay = new PairingDisplay();
