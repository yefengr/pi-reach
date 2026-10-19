import { useEffect, useRef, useState } from "react";
import { Button, NativeSelect } from "@mantine/core";
import { SettingsPage } from "@/components/pwa/settings-page";
import { PairingDialog } from "@/components/pwa/pairing-dialog";
import { ConfirmActionDialog, type ConfirmActionDialogAction } from "@/components/pwa/confirm-action-dialog";
import { RenamePairingDialog } from "@/components/pwa/rename-pairing-dialog";
import { KeyboardShortcutsDialog } from "@/components/pwa/keyboard-shortcuts-dialog";
import { PwaOperationNotifications } from "@/components/pwa/pwa-operation-notifications";
import { createOperationNotificationController, type OperationNotificationController } from "@/lib/pwa/operation-notifications";
import type { PwaDeviceRecord } from "@/lib/pwa/db";
import type { PairingErrorCode } from "@/lib/pwa/use-device-pairing";
import type { LanguagePreference } from "@/lib/i18n";
import type { PwaTextSize } from "@/lib/ui/text-size";
import { GALLERY_DEVICES } from "./ui-state-shell-fixtures";

export type GallerySurface = "settings" | "pairing" | "confirm" | "rename" | "shortcuts" | null;

// 业务反馈固定时长，不随展厅的动画慢放改变。
const OPERATION_PREVIEW_MS = 900;

function usePreviewOperation(surface: GallerySurface) {
  const timers = useRef(new Map<ReturnType<typeof setTimeout>, (active: boolean) => void>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const [timer, resolve] of pending) {
        clearTimeout(timer);
        resolve(false);
      }
      pending.clear();
    };
  }, [surface]);
  return () => new Promise<boolean>(resolve => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      resolve(true);
    }, OPERATION_PREVIEW_MS);
    timers.current.set(timer, resolve);
  });
}

function GallerySurfaceControls({ inactive, open, outcome, setOutcome, controller, refresh }: {
  inactive: boolean;
  open: (next: GallerySurface) => void;
  outcome: string;
  setOutcome: (value: string) => void;
  controller: OperationNotificationController;
  refresh: (value: boolean) => void;
}) {
  return <section className="pwa-ui-states-surfaces" aria-label="页面与叠层演示" inert={inactive} aria-hidden={inactive || undefined}>
    <div className="pwa-ui-states-surface-controls">
      <Button variant="default" onClick={() => open("settings")}>预览设置页</Button>
      <Button variant="default" onClick={() => open("pairing")}>输入配对码</Button>
      <Button variant="default" onClick={() => open("confirm")}>操作确认</Button>
      <Button variant="default" onClick={() => open("rename")}>重命名电脑</Button>
      <Button variant="default" onClick={() => open("shortcuts")}>快捷键帮助</Button>
      <NativeSelect label="确认操作结果" value={outcome} onChange={event => setOutcome(event.currentTarget.value)} data={[{ value: "success", label: "成功" }, { value: "error", label: "失败（保留确认框）" }]} />
    </div>
    <div className="pwa-ui-states-surface-controls">
      <Button variant="default" onClick={() => controller.notify("操作成功（仅本页演示）。")}>成功 Toast</Button>
      <Button variant="default" onClick={() => controller.show("preference-save")}>错误 Toast</Button>
      <Button variant="default" onClick={() => controller.showUpdate("发现新版本（仅本页演示）。", { label: "刷新（仅演示）", onClick: () => refresh(true) }, () => refresh(false))}>更新 Toast</Button>
    </div>
    <p className="pwa-ui-states-note">设置仅演示页面和操作结果，不演示 /app/settings 路由转场。语言仅预览选中状态，不切换全局翻译；发送键偏好仅用于本页设置与帮助。配对只展示本地连接中与错误，不发送配对码。</p>
  </section>;
}

export function UiStateSurfaces({ surface, onSurfaceChange, showControls = true, device = GALLERY_DEVICES[0] }: {
  surface: GallerySurface;
  onSurfaceChange: (next: GallerySurface) => void;
  showControls?: boolean;
  device?: PwaDeviceRecord;
}) {
  const [controller] = useState(createOperationNotificationController);
  const [language, setLanguage] = useState<LanguagePreference>("system");
  const [enterSends, setEnterSends] = useState(true);
  const [textSize, setTextSize] = useState<PwaTextSize>("standard");
  const [nicknames, setNicknames] = useState<Record<string, string>>({});
  const [previousSurface, setPreviousSurface] = useState(surface);
  const [settingsVisible, setSettingsVisible] = useState(surface === "settings");
  const [confirmAction, setConfirmAction] = useState<ConfirmActionDialogAction>({ kind: "new-session" });
  const [outcome, setOutcome] = useState("success");
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pairingPending, setPairingPending] = useState(false);
  const [pairingError, setPairingError] = useState<PairingErrorCode | null>(null);
  const [refreshPreview, setRefreshPreview] = useState(false);
  const confirmPendingRef = useRef(false);
  const pairingPendingRef = useRef(false);
  const wait = usePreviewOperation(surface);

  // 一个公开 surface 表示最高层；从设置进入帮助／确认时保留底层页面。
  if (previousSurface !== surface) {
    setPreviousSurface(surface);
    if (surface !== "confirm" && surface !== "shortcuts") setSettingsVisible(surface === "settings");
    setConfirmPending(false);
    setPairingPending(false);
    setConfirmError(null);
    setPairingError(null);
    if (surface !== "confirm") setConfirmAction({ kind: "new-session" });
  }
  useEffect(() => {
    confirmPendingRef.current = false;
    pairingPendingRef.current = false;
  }, [surface]);

  const closeOverlay = () => onSurfaceChange(settingsVisible ? "settings" : null);
  const confirm = async () => {
    if (confirmPendingRef.current) return;
    confirmPendingRef.current = true;
    setConfirmPending(true);
    setConfirmError(null);
    const succeeded = await wait();
    if (!succeeded) return;
    confirmPendingRef.current = false;
    setConfirmPending(false);
    if (outcome === "error") {
      setConfirmError("演示操作失败，请重试；本地数据保持不变。");
      return;
    }
    controller.notify("演示操作已完成；未创建会话或清除数据。");
    closeOverlay();
  };
  const pair = async () => {
    if (pairingPendingRef.current) return;
    pairingPendingRef.current = true;
    setPairingPending(true);
    setPairingError(null);
    if (!await wait()) return;
    pairingPendingRef.current = false;
    setPairingPending(false);
    setPairingError("unknown_code");
  };
  const saveSettings = async () => {
    if (await wait()) controller.notify("设置已保存（仅本页内存演示）。");
  };
  const rename = async (nickname: string) => {
    if (await wait()) {
      setNicknames(current => ({ ...current, [device.id]: nickname }));
      controller.notify("电脑名称已保存（仅演示，未写入配对记录）。");
    }
  };
  const openSurface = (next: GallerySurface) => {
    if (confirmPendingRef.current || pairingPendingRef.current) return;
    if (next === "confirm") setConfirmAction({ kind: "new-session" });
    onSurfaceChange(next);
  };

  return <>
    {showControls ? <GallerySurfaceControls inactive={settingsVisible} open={openSurface} outcome={outcome} setOutcome={setOutcome} controller={controller} refresh={setRefreshPreview} /> : null}
    {refreshPreview ? <p className="pwa-ui-states-note" role="status">已演示刷新操作；当前页面保持原样。</p> : null}
    <div className="pwa-ui-states-settings" hidden={!settingsVisible}>
      <SettingsPage
        preferences={{ language, setLanguage, enterSends, setEnterSends, textSize, setTextSize }}
        relayUrl="https://relay.invalid"
        defaultRelayUrl="https://relay.invalid"
        relayVersion={null}
        relayStatus="offline"
        extensionVersion={null}
        extensionStatus="offline"
        extensionTarget={null}
        onSave={saveSettings}
        onBack={() => onSurfaceChange(null)}
        backLabel="返回展厅"
        onClearData={() => { setConfirmAction({ kind: "clear-local-data" }); onSurfaceChange("confirm"); }}
        onResetLayout={() => controller.notify("已演示重置布局；展厅布局保持不变。")}
        onShowShortcuts={() => onSurfaceChange("shortcuts")}
      />
    </div>
    <PairingDialog opened={surface === "pairing"} connecting={pairingPending} error={pairingError} onSubmit={() => { void pair(); }} onClearError={() => setPairingError(null)} onClose={() => { if (!pairingPendingRef.current) closeOverlay(); }} codeOnly />
    <ConfirmActionDialog action={surface === "confirm" ? confirmAction : null} pending={confirmPending} error={confirmError} onConfirm={() => { void confirm(); }} onClose={() => { if (!confirmPendingRef.current) closeOverlay(); }} />
    {surface === "rename" ? <RenamePairingDialog device={{ ...device, nickname: nicknames[device.id] ?? device.nickname }} onSave={rename} onClose={closeOverlay} focusFallbackSelectors={[".pwa-ui-states-surface-controls button", ".pwa-settings-back"]} /> : null}
    <KeyboardShortcutsDialog opened={surface === "shortcuts"} onClose={closeOverlay} returnFocus enterSends={enterSends} />
    <PwaOperationNotifications controller={controller} />
  </>;
}
