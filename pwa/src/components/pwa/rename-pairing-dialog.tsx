import { useEffect, useRef, useState } from "react";
import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import type { PwaDeviceRecord } from "@/lib/pwa/db";
import { displayDevice } from "@/components/pwa/workspace-view";
import { useI18n } from "@/lib/i18n";

type RenamePairingDialogProps = {
  device: PwaDeviceRecord;
  onSave: (nickname: string) => Promise<void>;
  onClose: () => void;
  focusOrigin?: HTMLElement | null;
  focusFallbackSelectors?: readonly string[];
};

function suggestedName(device: PwaDeviceRecord): string {
  return device.nickname || device.hostname || "";
}

export function RenamePairingDialog({ device, onSave, onClose, focusOrigin = null, focusFallbackSelectors = [] }: RenamePairingDialogProps) {
  const [value, setValue] = useState(() => suggestedName(device));
  const [saving, setSaving] = useState(false);
  const { t } = useI18n();
  const [saveError, setSaveError] = useState(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(false);
  const focusOriginRef = useRef<HTMLElement | null>(focusOrigin);
  const focusOriginCapturedRef = useRef(focusOrigin !== null);
  const focusFallbackSelectorsRef = useRef(focusFallbackSelectors);

  useEffect(() => {
    mountedRef.current = true;
    if (!focusOriginCapturedRef.current) {
      focusOriginCapturedRef.current = true;
      const activeElement = document.activeElement;
      focusOriginRef.current = activeElement instanceof HTMLElement && activeElement !== document.body && activeElement !== document.documentElement
        ? activeElement
        : null;
    }
    const input = document.getElementById("pwa-rename-input") as HTMLInputElement | null;
    input?.focus();
    input?.select();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const restoreFocusAndClose = () => {
    if (savingRef.current) return;
    const candidates = [
      focusOriginRef.current,
      ...focusFallbackSelectorsRef.current.map((selector) => document.querySelector<HTMLElement>(selector)),
    ];
    const focusTarget = candidates.find((candidate): candidate is HTMLElement => (
      candidate !== null
      && candidate !== document.body
      && candidate !== document.documentElement
      && candidate.isConnected
      && !candidate.matches(":disabled")
      && candidate.getClientRects().length > 0
      && !candidate.closest('[aria-hidden="true"], [inert]')
    ));
    focusTarget?.focus({ preventScroll: true });
    onClose();
  };

  const nickname = value.trim();
  const submit = async () => {
    if (!nickname || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(false);
    let saved = false;
    try {
      await onSave(nickname);
      saved = true;
    } catch {
      if (mountedRef.current) setSaveError(true);
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
    if (saved && mountedRef.current) restoreFocusAndClose();
  };

  return <Modal
    opened
    onClose={restoreFocusAndClose}
    title={<div><span className="pwa-kicker">{t.rename.kicker}</span><Text component="h2" id="pwa-rename-title">{t.rename.title}</Text></div>}
    aria-labelledby="pwa-rename-title"
    aria-describedby="pwa-rename-description"
    centered
    size={480}
    withinPortal={false}
    trapFocus
    returnFocus
    closeOnClickOutside={!saving}
    closeOnEscape={!saving}
    closeButtonProps={{ disabled: saving, "aria-label": t.rename.close, title: t.common.close }}
    classNames={{ content: "pwa-rename-dialog", header: "pwa-rename-head", close: "pwa-icon-button" }}
    styles={{ header: { minHeight: 0, padding: 0 }, body: { padding: 0 } }}
  >
    <Stack gap={0}>
      <Text component="p" id="pwa-rename-description" className="pwa-rename-description">{t.rename.descriptionBefore}<Text component="strong">{displayDevice(device)}</Text>{t.rename.descriptionAfter}</Text>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <TextInput
          className="pwa-input pwa-rename-field"
          id="pwa-rename-input"
          label={t.rename.label}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={80}
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          data-autofocus
          disabled={saving}
        />
        {saveError ? <Text component="p" className="pwa-error" role="alert">{t.rename.saveFailed}</Text> : null}
        <Group className="pwa-rename-actions" justify="flex-end" gap="xs">
          <Button variant="default" type="button" onClick={restoreFocusAndClose} disabled={saving}>{t.common.cancel}</Button>
          <Button type="submit" disabled={!nickname || saving}>{saving ? t.rename.saving : t.rename.save}</Button>
        </Group>
      </form>
    </Stack>
  </Modal>;
}
