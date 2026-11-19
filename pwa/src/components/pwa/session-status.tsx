import { GitBranch } from "lucide-react";
import type { SessionStatusView } from "@/lib/pwa/session-status";
import { useI18n } from "@/lib/i18n";
import { presenceProps, usePresence } from "./use-presence";

export type SessionStatusProps = { view: SessionStatusView; title: string; deviceName?: string | null; cwd?: string | null };

const PLACEHOLDER_KINDS = ["offline", "loading", "unsupported", "unavailable"] as const;

/** 只保留非实时占位文案；离开层脱离文档流并受新内容边界裁切。 */
function SessionStatusPlaceholder({ status, kind }: { status?: SessionStatusProps; kind: typeof PLACEHOLDER_KINDS[number] }) {
  const presence = usePresence(status?.view.kind === kind ? status : null);
  if (!presence.rendered) return null;
  return <div className="pwa-session-status-kind pwa-presence" data-kind={kind} {...presenceProps(presence)}><SessionStatusContent {...presence.rendered} /></div>;
}

/** 会话离开时保留外壳淡出；状态切换立即替换内容，不把旧数值留到离线态。 */
export function SessionStatusCard({ status }: { status?: SessionStatusProps }) {
  const { t } = useI18n();
  const presence = usePresence(status ?? null);
  if (!presence.rendered) return null;
  const content = status ?? (presence.rendered.view.kind !== "ready" ? presence.rendered : undefined);
  return <aside className="pwa-session-status-card pwa-presence" aria-label={t.sessionStatus.title} {...presenceProps(presence)}>
    <h2>{t.sessionStatus.title}</h2>
    <div className="pwa-session-status-kinds">
      {content?.view.kind === "ready" ? <div className="pwa-session-status-kind pwa-presence" data-kind="ready"><SessionStatusContent {...content} /></div> : null}
      {PLACEHOLDER_KINDS.map(kind => <SessionStatusPlaceholder key={kind} status={content} kind={kind} />)}
    </div>
  </aside>;
}

export function formatStatusTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

/** 占用饼图：细外框加扇形，与数值同号；占用未知时只留虚线外框。 */
function ContextPie({ percent, level }: { percent: number | null; level: string | null }) {
  const filled = percent === null ? null : Math.max(0, Math.min(100, percent));
  return <svg className="pwa-session-status-pie" viewBox="0 0 24 24" data-level={level ?? "unknown"} aria-hidden="true">
    <circle className="pwa-session-status-pie-track" cx="12" cy="12" r="10" pathLength={100} />
    {filled === null ? null : <circle className="pwa-session-status-pie-fill" cx="12" cy="12" r="5" pathLength={100} strokeDasharray={`${filled} 100`} />}
  </svg>;
}

function BranchGlyph() {
  return <GitBranch aria-hidden="true" className="pwa-session-status-branch-icon" />;
}

export function SessionStatusContent({ view, title, deviceName, cwd, mobile = false }: SessionStatusProps & { mobile?: boolean }) {
  const { t } = useI18n();
  const copy = t.sessionStatus;
  const status = view.kind === "ready" ? view.status : null;
  const context = status?.context;
  const percent = context && context.tokens !== null ? context.tokens / context.window * 100 : null;
  const level = context?.level ?? null;
  const extensions = (section?: "context" | "usage" | "session") => status?.extensions.filter((entry) => entry.section === section) ?? [];
  const extensionRows = (section?: "context" | "usage" | "session") => extensions(section).map((entry) => <div className="pwa-session-status-row" key={entry.key}><dt>{entry.label}</dt><dd title={entry.text} data-tone={entry.tone}>{entry.text}</dd></div>);
  const row = (label: string, value: string) => <div className="pwa-session-status-row" key={label}><dt>{label}</dt><dd>{value}</dd></div>;
  const levelTag = level === "high" || level === "full" ? <span className="pwa-session-status-level" data-level={level}>{level === "high" ? copy.high : copy.full}</span> : null;
  const contextMeta = context ? `${context.tokens === null ? `${copy.window} ${formatStatusTokens(context.window)}` : `${formatStatusTokens(context.tokens)} / ${formatStatusTokens(context.window)}`} · ${context.auto_compact ? copy.autoCompact : copy.autoCompactOff}` : "";
  const contextRow = context ? <div className="pwa-session-status-row pwa-session-status-context-row">
    <dt className="pwa-session-status-context-key">{mobile ? copy.occupied : copy.context}{levelTag}</dt>
    <dd className="pwa-session-status-percent"><ContextPie percent={percent} level={level} />{percent === null ? null : `${percent.toFixed(1)}%`}</dd>
    <dd className="pwa-session-status-meta">{contextMeta}</dd>
  </div> : null;
  const sessionInfo = <>
    <div className="pwa-session-status-row pwa-session-status-stack">
      <dt className="pwa-sr-only">{copy.name}</dt>
      <dd className="pwa-session-status-name">{title}</dd>
      {deviceName ? <dd className="pwa-session-status-meta">{deviceName}</dd> : null}
    </div>
    {cwd ? <div className="pwa-session-status-row pwa-session-status-stack pwa-session-status-path"><dt>{t.actions.workingDirectory}</dt><dd><textarea className="pwa-session-info-cwd" aria-label={t.actions.workingDirectory} readOnly value={cwd} rows={1} /></dd></div> : null}
    {status?.branch ? <div className="pwa-session-status-row pwa-session-status-stack"><dt>{copy.branch}</dt><dd className="pwa-session-status-branch"><BranchGlyph /><span title={status.branch}>{status.branch}</span></dd></div> : null}
    {extensionRows("session")}
  </>;
  if (!status) return <div className="pwa-session-status-content" data-mobile={mobile || undefined}>
    <p className="pwa-session-status-note" role="status">{copy[view.kind === "ready" ? "unavailable" : view.kind]}</p>
    {mobile ? <section className="pwa-session-status-section"><h3>{copy.session}</h3><dl className="pwa-session-status-group">{sessionInfo}</dl></section> : null}
  </div>;
  const cacheHitRows = status.usage.cache_read + status.usage.cache_write > 0 ? <>
    {status.usage.cache_hit_rate_session !== null ? row(copy.cacheHit, `${status.usage.cache_hit_rate_session.toFixed(1)}%`) : null}
    {status.usage.cache_hit_rate_latest !== null ? row(copy.cacheHitLatest, `${status.usage.cache_hit_rate_latest.toFixed(1)}%`) : null}
  </> : null;
  const usageRows = <>
    {row(copy.input, formatStatusTokens(status.usage.input))}{row(copy.output, formatStatusTokens(status.usage.output))}
    {row(copy.cacheRead, formatStatusTokens(status.usage.cache_read))}{row(copy.cacheWrite, formatStatusTokens(status.usage.cache_write))}
    {cacheHitRows}{row(copy.cost, `$${status.usage.cost.toFixed(3)}`)}
  </>;
  if (mobile) return <div className="pwa-session-status-content" data-mobile>
    {context || extensions("context").length ? <section className="pwa-session-status-section"><h3>{copy.context}</h3><dl className="pwa-session-status-group">{contextRow}{extensionRows("context")}</dl></section> : null}
    <section className="pwa-session-status-section"><h3>{copy.usage}</h3><dl className="pwa-session-status-group">{usageRows}{extensionRows("usage")}</dl><p className="pwa-session-status-note">{copy.usageNote}</p></section>
    {extensions().length ? <section className="pwa-session-status-section" aria-label={copy.otherStatus}><dl className="pwa-session-status-group">{extensionRows()}</dl></section> : null}
    <section className="pwa-session-status-section"><h3>{copy.session}</h3><dl className="pwa-session-status-group">{sessionInfo}</dl></section>
  </div>;
  return <div className="pwa-session-status-content">
    {context || extensions("context").length ? <div className="pwa-session-status-block"><dl className="pwa-session-status-list">{contextRow}{extensionRows("context")}</dl></div> : null}
    <div className="pwa-session-status-block"><dl className="pwa-session-status-list">{usageRows}{extensionRows("usage")}</dl></div>
    {extensions().length ? <div className="pwa-session-status-block"><dl className="pwa-session-status-list">{extensionRows()}</dl></div> : null}
    {status.branch || extensions("session").length ? <div className="pwa-session-status-block">
      {status.branch ? <div className="pwa-session-status-row pwa-session-status-branch-row"><span className="pwa-sr-only">{copy.branch}</span><BranchGlyph /><span className="pwa-session-status-branch-text" title={status.branch}>{status.branch}</span></div> : null}
      {extensions("session").length ? <dl className="pwa-session-status-list">{extensionRows("session")}</dl> : null}
    </div> : null}
  </div>;
}
