import { Button } from "@mantine/core";
import { CircleAlert, RefreshCw } from "lucide-react";
import { BrandMark } from "@/components/pwa/brand-mark";
import { getMessages, useI18n } from "@/lib/i18n";
export type StartupError = {
  title: string;
  message: string;
  action?: string;
};

export function describeStartupFailure(failure: unknown): StartupError {
  const t = getMessages().startup;
  const message = failure instanceof Error ? failure.message : String(failure);
  if (message === "secure_context_required" || (typeof window !== "undefined" && !window.isSecureContext)) return { title: t.secureTitle, message: t.secureBody, action: t.secureAction };
  if (message === "web_crypto_unavailable" || typeof globalThis.crypto?.getRandomValues !== "function") return { title: t.cryptoTitle, message: t.cryptoBody };
  if (message === "indexeddb_unavailable" || typeof indexedDB === "undefined") return { title: t.storageTitle, message: t.storageBody };
  const databaseCode = typeof failure === "object" && failure !== null && "code" in failure ? failure.code : undefined;
  if (databaseCode === "blocked") return { title: t.busyTitle, message: t.busyBody };
  if (databaseCode === "versionchange") return { title: t.changedTitle, message: t.changedBody };
  if (databaseCode === "open_failed") return { title: t.openFailedTitle, message: t.openFailedBody };
  if (message === "startup_timeout") return { title: t.timeoutTitle, message: t.timeoutBody };
  // 未识别的失败只给通用说明：原始异常可能含浏览器内部信息，不直接展示给用户。
  return { title: t.openFailedTitle, message: t.genericBody, action: t.reloadAction };
}

/** visible 为 false 时只铺底色：启动图之后接一片同色底，而不是一闪而过的标识与文字。 */
export function StartupLoading({ visible = true }: { visible?: boolean }) {
  const { t } = useI18n();
  return <div className="pwa-loading">{visible ? <div><BrandMark className="pwa-loading-mark" size={48} /><p>{t.startup.opening}</p></div> : null}</div>;
}

export function StartupErrorView({ error, onRetry }: { error: StartupError | null; onRetry: () => void }) {
  const { t } = useI18n();
  return <main className="pwa-startup-error"><div className="pwa-card pwa-startup-card"><span className="pwa-startup-icon"><CircleAlert size={24} /></span><h1>{error?.title || t.startup.unavailableTitle}</h1><p>{error?.message || t.startup.unavailableBody}</p>{error?.action ? <p className="pwa-startup-action-note">{error.action}</p> : null}<div className="pwa-startup-actions"><Button type="button" onClick={onRetry} leftSection={<RefreshCw size={16} />}>{t.startup.reload}</Button></div></div></main>;
}
