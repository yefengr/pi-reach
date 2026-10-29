import { useMemo, useState, useSyncExternalStore } from "react";
import { Button, Stack, Textarea } from "@mantine/core";
import { CopyButton } from "./copy-button";
import { useI18n } from "@/lib/i18n";
import { viewportDiagnosticCapture } from "@/lib/pwa/timeline-viewport-diagnostics";
import { readCaptureMetadata } from "@/lib/pwa/timeline-viewport-diagnostic-capture";
import { version } from "../../../package.json";

const DOWNLOAD_URL_RELEASE_MS = 1000;

export function ViewportDiagnosticsSettings({ online }: { online: boolean }) {
  const { t } = useI18n();
  const s = t.settings.viewportDiagnostics;
  const state = useSyncExternalStore(viewportDiagnosticCapture.subscribe, viewportDiagnosticCapture.getSnapshot);
  const json = useMemo(() => state.report ? JSON.stringify(state.report, null, 2) : "", [state.report]);
  const [saveFailed, setSaveFailed] = useState(false);
  const pending = state.phase === "armed" || state.phase === "recording";
  const save = () => {
    if (!json) return;
    let url: string | null = null;
    setSaveFailed(false);
    try {
      url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "pi-reach-viewport.json";
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
    } catch { setSaveFailed(true); }
    finally {
      if (url) {
        const savedUrl = url;
        // 下载的消费窗口独立于设置页；返回或清除报告不能提前撤销地址。
        // 定时器只回收 URL，不保留组件引用，也不更新 UI、采样或业务状态。
        window.setTimeout(() => URL.revokeObjectURL(savedUrl), DOWNLOAD_URL_RELEASE_MS);
      }
    }
  };
  return <section className="pwa-settings-section" aria-labelledby="pwa-viewport-diagnostics-heading">
    <h2 id="pwa-viewport-diagnostics-heading" className="pwa-settings-section-title">{s.title}</h2>
    <p className="pwa-settings-section-description">{s.hint}</p>
    <Stack gap="xs">
      <p className="pwa-settings-section-description" role="status">{s[state.phase]}</p>
      {!online ? <p className="pwa-settings-section-description">{s.offline}</p> : null}
      <div className="pwa-settings-actions">
        <Button variant="default" type="button" disabled={!online || pending} onClick={() => { setSaveFailed(false); viewportDiagnosticCapture.arm(readCaptureMetadata(version)); }}>{s.prepare}</Button>
        {pending ? <Button variant="transparent" type="button" onClick={viewportDiagnosticCapture.cancel}>{s.cancel}</Button> : null}
        {!pending && state.phase !== "off" ? <Button variant="transparent" type="button" onClick={() => { setSaveFailed(false); viewportDiagnosticCapture.clear(); }}>{s.clear}</Button> : null}
      </div>
      {state.report ? <>
        <div className="pwa-settings-actions">
          <CopyButton key={json} text={json} label={s.copy} />
          <Button variant="default" type="button" onClick={save}>{s.save}</Button>
        </div>
        {saveFailed ? <p className="pwa-settings-section-description" role="status">{s.saveFailed}</p> : null}
        <Textarea label={s.json} description={s.jsonHint} value={json} readOnly rows={8} spellCheck={false} />
      </> : null}
    </Stack>
  </section>;
}
