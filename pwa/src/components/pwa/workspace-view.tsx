import { useState, type ReactNode } from "react";
import { Button, NavLink } from "@mantine/core";
import { History, Link2, LoaderCircle, MessageSquare, Settings } from "lucide-react";
import { WorkspaceDeviceControl, type WorkspaceDeviceControlVariant } from "@/components/pwa/workspace-device-control";
import { displayPi } from "@/components/pwa/session-title";
import type { PwaDeviceRecord, PwaEndpointRecord } from "@/lib/pwa/db";
import { historySessionTitle } from "@/lib/pwa/history-preview";
import type { TimelineSessionSummary } from "@/lib/pwa/timeline-store";
import type { PairingPresence } from "@/lib/pwa/pwa-view-model";
import { BrandMark } from "@/components/pwa/brand-mark";
import { useI18n } from "@/lib/i18n";

export { displayDevice } from "@/components/pwa/workspace-device-control";
export { displayPi } from "@/components/pwa/session-title";
export type { PairingPresence, PairingStatus } from "@/lib/pwa/pwa-view-model";
export type ConnectionViewState = "offline" | "connecting" | "online" | "retrying" | "no_network";

const navigationNavLinkClassNames = {
  body: "pwa-nav-link-body",
  label: "pwa-nav-link-label",
  description: "pwa-nav-link-description",
  section: "pwa-nav-link-section",
} as const;

export function ConnectionStatus({ state, retryAttempt = 0 }: { state: ConnectionViewState; retryAttempt?: number }) {
  const { t } = useI18n();
  const label = state === "online" ? t.connection.connected : state === "connecting" ? t.connection.connecting : state === "retrying" ? t.connection.reconnecting : state === "no_network" ? t.connection.noNetwork : t.connection.offline;
  const busy = state === "connecting" || state === "retrying";
  return <span className={`pwa-connection ${state}`} title={label} aria-label={label} data-retry-attempt={state === "retrying" ? retryAttempt : undefined}>{busy ? <LoaderCircle className="pwa-spin" size={12} aria-hidden="true" /> : <span className="pwa-status-dot" aria-hidden="true" />}<span className="pwa-connection-label">{label}</span></span>;
}

export type WorkspaceNavigationProps = {
  devices: PwaDeviceRecord[];
  endpoints: PwaEndpointRecord[];
  history: TimelineSessionSummary[];
  activeDeviceId: string | null;
  activeEndpointId: string | null;
  selectedHistoryId: string | null;
  snapshotReady: boolean;
  pairingPresence?: Record<string, PairingPresence>;
  /** 后台完成提醒：非当前查看、由运行中变为空闲的在线 Pi。 */
  completedEndpointIds?: ReadonlySet<string>;
  onPair: () => void;
  onSettings: () => void;
  onSelectDevice: (deviceId: string) => void;
  onSelectEndpoint: (endpointId: string) => void;
  onSelectHistory: (history: TimelineSessionSummary) => void;
  onRename: (device: PwaDeviceRecord) => void;
  onRemove: (device: PwaDeviceRecord) => void;
  idPrefix?: string;
};

type NavigationVariant = WorkspaceDeviceControlVariant;

type WorkspaceRunningPiSectionProps = Pick<WorkspaceNavigationProps, "endpoints" | "activeEndpointId" | "selectedHistoryId" | "snapshotReady" | "completedEndpointIds" | "onSelectEndpoint"> & {
  activeDevice: PwaDeviceRecord | null;
  headingId: string;
  variant?: NavigationVariant;
};

type WorkspaceHistorySectionProps = Pick<WorkspaceNavigationProps, "history" | "selectedHistoryId" | "onSelectHistory"> & {
  activeDevice: PwaDeviceRecord | null;
  headingId: string;
  variant?: NavigationVariant;
};

type WorkspaceNavigationFooterProps = Pick<WorkspaceNavigationProps, "onPair" | "onSettings"> & {
  /** 从设置页返回导航时，焦点落在设置入口上。 */
  autoFocusSettings?: boolean;
  className?: string;
};

type WorkspaceNavigationContentProps = WorkspaceNavigationProps & {
  collapsed?: boolean;
};

type DesktopSidebarProps = WorkspaceNavigationProps & {
  collapsed?: boolean;
};

export function getActiveDevice(devices: PwaDeviceRecord[], activeDeviceId: string | null): PwaDeviceRecord | null {
  return devices.find((device) => device.id === activeDeviceId) ?? null;
}

function sectionClassName(variant: NavigationVariant): string {
  return variant === "sheet" ? "pwa-nav-section pwa-session-sheet-section" : "pwa-nav-section";
}

function sectionHeadingClassName(variant: NavigationVariant): string {
  return variant === "sheet" ? "pwa-nav-section-heading pwa-sheet-section-head" : "pwa-nav-section-heading";
}

export function cwdName(cwd?: string | null): string | null {
  return cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
}

/** 在线 Pi 行：会话名；第二行为工作目录最后一级 · 运行中／空闲。不显示模型名。 */
export function OnlinePiRow({ endpoint, current, completed, onSelect, variant = "desktop", trailing }: { endpoint: PwaEndpointRecord; current: boolean; completed: boolean; onSelect: () => void; variant?: NavigationVariant; trailing?: ReactNode }) {
  const { t } = useI18n();
  const directory = cwdName(endpoint.cwd);
  const status = endpoint.working
    ? <span className="pwa-pi-status pwa-pi-status-running"><LoaderCircle className="pwa-spin" size={12} aria-hidden="true" />{t.actions.running}</span>
    : <span className="pwa-pi-status">{t.actions.idle}</span>;
  return <NavLink
    className={`pwa-nav-session${variant === "sheet" ? " pwa-sheet-room" : ""}`}
    classNames={navigationNavLinkClassNames}
    component="button"
    type="button"
    label={displayPi(endpoint)}
    title={displayPi(endpoint)}
    description={<>{directory ? <span className="pwa-pi-directory">{directory}<span aria-hidden="true"> · </span></span> : null}{status}</>}
    rightSection={completed && !current ? <span className="pwa-notice-dot" role="img" aria-label={t.navigation.newReply} /> : trailing}
    active={current}
    aria-current={current ? "true" : undefined}
    noWrap
    onClick={() => { if (!current) onSelect(); }}
  />;
}

function SkeletonRows() {
  return <div className="pwa-nav-skeleton" aria-hidden="true"><span className="pwa-skeleton" /><span className="pwa-skeleton" /></div>;
}

export function WorkspaceRunningPiSection({ activeDevice, endpoints, activeEndpointId, selectedHistoryId, snapshotReady, completedEndpointIds, onSelectEndpoint, headingId, variant = "desktop" }: WorkspaceRunningPiSectionProps) {
  const { t } = useI18n();
  if (!activeDevice) return null;
  const activePis = endpoints.filter((endpoint) => endpoint.deviceId === activeDevice.deviceId && endpoint.online !== false).sort((left, right) => displayPi(left).localeCompare(displayPi(right)));
  return <section className={sectionClassName(variant)} aria-labelledby={headingId} aria-busy={!snapshotReady || undefined}>
    <div className={sectionHeadingClassName(variant)} id={headingId}><MessageSquare size={16} /><span>{t.navigation.onlinePi}</span>{snapshotReady ? <small className="pwa-tabular">{activePis.length}</small> : null}</div>
    {!snapshotReady ? <><span className="pwa-sr-only">{t.navigation.checkingPi}</span><SkeletonRows /></> : activePis.length === 0 ? <p className="pwa-nav-empty">{t.navigation.noPiOnline}</p> : activePis.map((endpoint) => <OnlinePiRow
      key={endpoint.id}
      endpoint={endpoint}
      current={selectedHistoryId === null && endpoint.endpointId === activeEndpointId}
      completed={completedEndpointIds?.has(endpoint.endpointId) ?? false}
      onSelect={() => onSelectEndpoint(endpoint.endpointId)}
      variant={variant}
    />)}
  </section>;
}

const HISTORY_PAGE_SIZE = 20;

export function WorkspaceHistorySection({ activeDevice, history, selectedHistoryId, onSelectHistory, headingId, variant = "desktop" }: WorkspaceHistorySectionProps) {
  const { t, format } = useI18n();
  const [visibleCount, setVisibleCount] = useState(HISTORY_PAGE_SIZE);
  if (!activeDevice) return null;
  const visible = history.slice(0, visibleCount);
  return <section className={sectionClassName(variant)} aria-labelledby={headingId}>
    <div className={sectionHeadingClassName(variant)} id={headingId}><History size={16} /><span className="pwa-nav-heading-copy"><strong>{t.navigation.localHistory}</strong><em>{t.navigation.savedInBrowser}</em></span><small className="pwa-tabular">{history.length}</small></div>
    {history.length === 0 ? <p className="pwa-nav-empty">{t.navigation.historyEmpty}</p> : visible.map((entry) => {
      const current = entry.id === selectedHistoryId;
      const title = historySessionTitle(entry);
      return <NavLink
        className={`pwa-history-row${variant === "sheet" ? " pwa-sheet-history" : ""}`}
        classNames={navigationNavLinkClassNames}
        component="button"
        type="button"
        key={entry.id}
        label={title}
        title={title}
        description={<time className="pwa-tabular" dateTime={new Date(entry.updatedAt).toISOString()}>{format.historyTime(entry.updatedAt)}</time>}
        active={current}
        aria-current={current ? "true" : undefined}
        noWrap
        onClick={() => { if (!current) onSelectHistory(entry); }}
      />;
    })}
    {history.length > visibleCount ? <Button className="pwa-history-more" variant="transparent" color="piReach" type="button" onClick={() => setVisibleCount((count) => count + HISTORY_PAGE_SIZE)}>{t.navigation.showEarlier}</Button> : null}
  </section>;
}

export function WorkspaceNavigationFooter({ onPair, onSettings, className = "pwa-sidebar-foot", autoFocusSettings = false }: WorkspaceNavigationFooterProps) {
  const { t } = useI18n();
  return <div className={className}>
    <Button className="pwa-nav-pair" variant="transparent" color="piReach" type="button" onClick={onPair} leftSection={<Link2 size={16} />}>{t.navigation.pairComputer}</Button>
    <Button className="pwa-nav-settings" variant="transparent" color="piReach" type="button" data-autofocus={autoFocusSettings || undefined} onClick={onSettings} aria-label={t.navigation.openSettings} leftSection={<Settings size={16} />}>{t.navigation.settings}</Button>
  </div>;
}

export function WorkspaceNavigationContent({ devices, endpoints, history, activeDeviceId, activeEndpointId, selectedHistoryId, snapshotReady, pairingPresence = {}, completedEndpointIds, onPair, onSettings, onSelectDevice, onSelectEndpoint, onSelectHistory, onRename, onRemove, idPrefix = "pwa-navigation", collapsed = false }: WorkspaceNavigationContentProps) {
  const activeDevice = getActiveDevice(devices, activeDeviceId);
  const runningHeading = `${idPrefix}-running-heading`;
  const historyHeading = `${idPrefix}-history-heading`;
  return <div className="pwa-navigation-content">
    <div className="pwa-sidebar-brand"><BrandMark className="pwa-brand-mark" size={24} /><span>Pi Reach</span></div>
    <div className="pwa-sidebar-head"><WorkspaceDeviceControl key={`pwa-device-picker-${collapsed}`} devices={devices} activeDeviceId={activeDeviceId} pairingPresence={pairingPresence} onPair={onPair} onSelectDevice={onSelectDevice} onRename={onRename} onRemove={onRemove} /></div>
    <div className="pwa-navigation-scroll">
      {activeDevice ? <>
        <WorkspaceRunningPiSection activeDevice={activeDevice} endpoints={endpoints} activeEndpointId={activeEndpointId} selectedHistoryId={selectedHistoryId} snapshotReady={snapshotReady} completedEndpointIds={completedEndpointIds} onSelectEndpoint={onSelectEndpoint} headingId={runningHeading} />
        <WorkspaceHistorySection activeDevice={activeDevice} history={history} selectedHistoryId={selectedHistoryId} onSelectHistory={onSelectHistory} headingId={historyHeading} />
      </> : null}
    </div>
    <WorkspaceNavigationFooter onPair={onPair} onSettings={onSettings} />
  </div>;
}

export function DesktopSidebar({ collapsed = false, ...props }: DesktopSidebarProps) {
  const { t } = useI18n();
  return <aside className="pwa-sidebar" aria-label={t.navigation.workspaceNavigation}><WorkspaceNavigationContent {...props} idPrefix="pwa-desktop" collapsed={collapsed} /></aside>;
}
