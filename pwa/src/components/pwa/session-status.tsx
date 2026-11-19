import type { SessionStatusView } from "@/lib/pwa/session-status";
import { useI18n } from "@/lib/i18n";

export type SessionStatusProps = { view: SessionStatusView; title: string; deviceName?: string | null; cwd?: string | null };

export function formatStatusTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

function ContextPie({ percent, level }: { percent: number | null; level: string | null }) {
  const fraction = Math.max(0, Math.min(100, percent ?? 0)) / 100;
  const angle = fraction * Math.PI * 2;
  const x = 10 + 8 * Math.sin(angle);
  const y = 10 - 8 * Math.cos(angle);
  return <svg className="pwa-session-status-pie" viewBox="0 0 20 20" data-level={level ?? "unknown"} aria-hidden="true">
    <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray={percent === null ? "2 2" : undefined} />
    {fraction >= 1 ? <circle cx="10" cy="10" r="7" fill="currentColor" /> : fraction > 0 ? <path d={`M10 10 L10 2 A8 8 0 ${fraction > 0.5 ? 1 : 0} 1 ${x} ${y} Z`} fill="currentColor" /> : null}
  </svg>;
}

export function SessionStatusContent({ view, title, deviceName, cwd, mobile = false }: SessionStatusProps & { mobile?: boolean }) {
  const { t } = useI18n();
  const copy = t.sessionStatus;
  const status = view.kind === "ready" ? view.status : null;
  const extensions = (section?: "context" | "usage" | "session") => status?.extensions.filter((entry) => entry.section === section) ?? [];
  const extensionRows = (section?: "context" | "usage" | "session") => extensions(section).map((entry) => <div className="pwa-session-status-row" key={entry.key}><dt>{entry.label}</dt><dd title={entry.text} data-tone={entry.tone}>{entry.text}</dd></div>);
  const row = (label: string, value: string) => <div className="pwa-session-status-row" key={label}><dt>{label}</dt><dd>{value}</dd></div>;
  const context = status?.context;
  const percent = context && context.tokens !== null ? context.tokens / context.window * 100 : null;
  const level = context?.level ?? null;
  const sessionRows = <>
    {mobile ? <>{row(copy.name, title)}{deviceName ? row(copy.computer, deviceName) : null}{cwd ? <div className="pwa-session-status-row pwa-session-status-path"><dt>{t.actions.workingDirectory}</dt><dd><textarea className="pwa-session-info-cwd" aria-label={t.actions.workingDirectory} readOnly value={cwd} rows={Math.min(5, Math.max(2, Math.ceil(cwd.length / 26)))} /></dd></div> : null}</> : null}
    {status?.branch ? <div className="pwa-session-status-row"><dt>{copy.branch}</dt><dd className="pwa-session-status-branch" title={status.branch}>{status.branch}</dd></div> : null}
    {extensionRows("session")}
  </>;
  return <div className="pwa-session-status-content" data-mobile={mobile || undefined}>
    {status ? <>
      {context || extensions("context").length ? <section className="pwa-session-status-section"><h3>{copy.context}</h3><div className="pwa-session-status-group">
        {context ? <><div className="pwa-session-status-context"><span className="pwa-session-status-percent"><ContextPie percent={percent} level={level} />{percent !== null ? `${percent.toFixed(1)}%` : null}</span>{level === "high" || level === "full" ? <span className="pwa-session-status-level" data-tone={level === "high" ? "warning" : "error"}>{level === "high" ? copy.high : copy.full}</span> : null}</div><p className="pwa-session-status-note">{context.tokens === null ? `${copy.window} ${formatStatusTokens(context.window)}` : `${formatStatusTokens(context.tokens)} / ${formatStatusTokens(context.window)}`} · {context.auto_compact ? copy.autoCompact : copy.autoCompactOff}</p></> : null}
        <dl>{extensionRows("context")}</dl>
      </div></section> : null}
      <section className="pwa-session-status-section"><h3>{copy.usage}</h3><dl className="pwa-session-status-group">
        {row(copy.input, formatStatusTokens(status.usage.input))}{row(copy.output, formatStatusTokens(status.usage.output))}{row(copy.cacheRead, formatStatusTokens(status.usage.cache_read))}{row(copy.cacheWrite, formatStatusTokens(status.usage.cache_write))}
        {status.usage.cache_read + status.usage.cache_write > 0 ? <>
          {status.usage.cache_hit_rate_session !== null ? row(copy.cacheHit, `${status.usage.cache_hit_rate_session.toFixed(1)}%`) : null}
          {status.usage.cache_hit_rate_latest !== null ? row(copy.cacheHitLatest, `${status.usage.cache_hit_rate_latest.toFixed(1)}%`) : null}
        </> : null}
        {row(copy.cost, `$${status.usage.cost.toFixed(3)}`)}{extensionRows("usage")}
      </dl>{mobile ? <p className="pwa-session-status-note">{copy.usageNote}</p> : null}</section>
      {extensions().length ? <section className="pwa-session-status-section"><dl className="pwa-session-status-group">{extensionRows()}</dl></section> : null}
    </> : <p className="pwa-session-status-note" role="status">{copy[view.kind === "ready" ? "unavailable" : view.kind]}</p>}
    {mobile || status?.branch || extensions("session").length ? <section className="pwa-session-status-section"><h3>{copy.session}</h3><dl className="pwa-session-status-group">{sessionRows}</dl></section> : null}
  </div>;
}
