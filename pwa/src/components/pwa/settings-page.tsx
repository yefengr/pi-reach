import { useRef, useState, type ReactNode, type Ref } from "react";
import { Button, Radio, Switch, TextInput, UnstyledButton } from "@mantine/core";
import { Check, ChevronLeft, ChevronRight, Download, Globe, Monitor, Moon, RotateCcw, Smartphone, Sun, Trash2 } from "lucide-react";
import { usePwaAppearance, type PwaAppearance } from "@/components/pwa/pwa-appearance";
import { usePwaTextSize } from "@/components/pwa/use-pwa-text-size";
import { setLanguagePreference, useI18n, type LanguagePreference } from "@/lib/i18n";
import type { PwaTextSizePreference } from "@/lib/ui/text-size";
import { ViewportDiagnosticsSettings } from "./viewport-diagnostics-settings";
import { CopyButton } from "@/components/pwa/copy-button";
import { InstallSteps, useInstallCopy, usePwaInstall, type InstallOffer } from "@/components/pwa/pwa-install";
import { shortcutLabel, useEnterSends } from "@/lib/pwa/keyboard-shortcuts";
import type { ConnectionViewState } from "@/components/pwa/workspace-view";
import { version as pwaVersion } from "../../../package.json";

export type SettingsPagePreferences = {
  language: LanguagePreference;
  setLanguage: (value: LanguagePreference) => void;
  enterSends: boolean;
  setEnterSends: (value: boolean) => void;
  textSize: PwaTextSizePreference;
  setTextSize: (value: PwaTextSizePreference) => void;
  /** 浏览器能读到系统文字大小时才提供「跟随系统」；否则该偏好按标准档显示。 */
  textSizeFollowsSystem?: boolean;
};

type SettingsPageProps = {
  preferences?: SettingsPagePreferences;
  viewportDiagnostics?: boolean;
  viewportDiagnosticsOnline?: boolean;
  relayUrl: string;
  defaultRelayUrl: string;
  relayVersion: string | null;
  relayStatus: ConnectionViewState;
  extensionVersion: string | null;
  extensionStatus: ConnectionViewState;
  extensionTarget: string | null;
  onSave: (value: string) => Promise<void>;
  onBack: () => void;
  /** 返回按钮的可访问名称随来源为「返回导航」或「返回工作区」。 */
  backLabel: string;
  onClearData: () => void;
  onResetLayout: () => void;
  onShowShortcuts: (origin: HTMLButtonElement) => void;
  titleRef?: Ref<HTMLHeadingElement>;
};

/**
 * 独立设置页：不保留工作区侧栏，内容最大宽 640，分区间距 32；各分区为 iOS 式分组列表（标题、分组、说明）。
 * 移动端返回箭头与标题同一行；桌面返回为带文字的按钮，标题在其下方。
 */
export function SettingsPage({ preferences, ...props }: SettingsPageProps) {
  return preferences ? <SettingsPageContent {...props} preferences={preferences} /> : <PersistedSettingsPage {...props} />;
}

function PersistedSettingsPage(props: Omit<SettingsPageProps, "preferences">) {
  const { preference } = useI18n();
  const [enterSends, setEnterSends] = useEnterSends();
  const { preference: textSize, followsSystem, setTextSize } = usePwaTextSize();
  return <SettingsPageContent {...props} preferences={{ language: preference, setLanguage: setLanguagePreference, enterSends, setEnterSends, textSize, setTextSize, textSizeFollowsSystem: followsSystem }} />;
}

function SettingsPageContent({ preferences, viewportDiagnostics = false, viewportDiagnosticsOnline = false, relayUrl, defaultRelayUrl, relayVersion, relayStatus, extensionVersion, extensionStatus, extensionTarget, onSave, onBack, backLabel, onClearData, onResetLayout, onShowShortcuts, titleRef }: Omit<SettingsPageProps, "preferences"> & { preferences: SettingsPagePreferences }) {
  const [value, setValue] = useState(relayUrl);
  const [saving, setSaving] = useState(false);
  const savePendingRef = useRef(false);
  const { appearance, setAppearance } = usePwaAppearance();
  const { t } = useI18n();
  const { enterSends, setEnterSends, setTextSize, textSizeFollowsSystem = false } = preferences;
  const textSize = preferences.textSize === "system" && !textSizeFollowsSystem ? "standard" : preferences.textSize;
  const s = t.settings;
  const versionText = (version: string | null, status: ConnectionViewState) => {
    if (status === "online") return version ?? s.versionUnavailable;
    if (status === "connecting" || status === "retrying") return s.gettingVersion;
    return s.notConnected;
  };
  const relayVersionText = versionText(relayVersion, relayStatus);
  const extensionVersionText = extensionTarget ? versionText(extensionVersion, extensionStatus) : s.noOnlinePi;
  const versionInfo = `PWA: ${pwaVersion}\nRelay: ${relayVersionText}\n${s.extension}: ${extensionVersionText}`;
  const save = async () => {
    if (savePendingRef.current) return;
    savePendingRef.current = true;
    setSaving(true);
    try {
      await onSave(value);
    } finally {
      savePendingRef.current = false;
      setSaving(false);
    }
  };

  return <div className="pwa-settings-page">
    <div className="pwa-status-bar-shield" aria-hidden="true" />
    <div className="pwa-settings-inner">
      <header className="pwa-settings-header">
        <Button className="pwa-settings-back" variant="transparent" type="button" onClick={onBack} aria-label={backLabel} title={backLabel} leftSection={<ChevronLeft size={20} aria-hidden="true" />}>
          <span className="pwa-settings-back-label">{backLabel}</span>
        </Button>
        <h1 id="pwa-settings-title" className="pwa-settings-title" ref={titleRef} tabIndex={-1}>{s.title}</h1>
      </header>
      <InstallSettingsSection />
      <section className="pwa-settings-section" aria-labelledby="pwa-appearance-heading">
        <h2 id="pwa-appearance-heading" className="pwa-settings-section-title">{s.appearance}</h2>
        <Radio.Group aria-label={s.appearance} name="pwa-appearance" value={appearance} onChange={(next) => setAppearance(next as PwaAppearance)}>
          <div className="pwa-card pwa-settings-group">
            <SettingsChoice value="system" icon={<Monitor size={20} />} title={s.system} hint={s.systemHint} />
            <SettingsChoice value="light" icon={<Sun size={20} />} title={s.light} hint={s.lightHint} />
            <SettingsChoice value="dark" icon={<Moon size={20} />} title={s.dark} hint={s.darkHint} />
          </div>
        </Radio.Group>
        <p className="pwa-settings-section-description pwa-settings-footnote">{s.appearanceHint}</p>
      </section>
      <section className="pwa-settings-section" aria-labelledby="pwa-text-size-heading">
        <h2 id="pwa-text-size-heading" className="pwa-settings-section-title">{s.textSize}</h2>
        <Radio.Group aria-label={s.textSize} name="pwa-text-size" value={textSize} onChange={(next) => setTextSize(next as PwaTextSizePreference)}>
          <div className="pwa-card pwa-settings-group">
            {textSizeFollowsSystem ? <SettingsChoice value="system" icon={<Smartphone size={20} />} title={s.textSizeSystem} hint={s.textSizeSystemHint} /> : null}
            <SettingsChoice value="standard" icon={<TextSizeGlyph size="standard" />} title={s.textSizeStandard} hint={s.textSizeStandardHint} />
            <SettingsChoice value="large" icon={<TextSizeGlyph size="large" />} title={s.textSizeLarge} hint={s.textSizeLargeHint} />
            <SettingsChoice value="xlarge" icon={<TextSizeGlyph size="xlarge" />} title={s.textSizeXLarge} hint={s.textSizeXLargeHint} />
          </div>
        </Radio.Group>
        <p className="pwa-settings-section-description pwa-settings-footnote">{s.textSizeHint}</p>
      </section>
      <section className="pwa-settings-section" aria-labelledby="pwa-language-heading">
        <h2 id="pwa-language-heading" className="pwa-settings-section-title">{s.language}</h2>
        <Radio.Group aria-label={s.language} name="pwa-language" value={preferences.language} onChange={(next) => preferences.setLanguage(next as LanguagePreference)}>
          <div className="pwa-card pwa-settings-group">
            <SettingsChoice value="system" icon={<Globe size={20} />} title={s.followBrowser} hint={s.followBrowserHint} />
            <SettingsChoice value="zh" icon={<LanguageGlyph lang="zh-CN">中</LanguageGlyph>} title={s.chinese} hint={s.chineseHint} lang="zh-CN" />
            <SettingsChoice value="en" icon={<LanguageGlyph lang="en">En</LanguageGlyph>} title={s.english} hint={s.englishHint} lang="en" />
          </div>
        </Radio.Group>
        <p className="pwa-settings-section-description pwa-settings-footnote">{s.languageHint}</p>
      </section>
      <section className="pwa-settings-section" aria-labelledby="pwa-keyboard-heading">
        <h2 id="pwa-keyboard-heading" className="pwa-settings-section-title">{s.keyboard}</h2>
        <div className="pwa-card pwa-settings-group">
          <Switch className="pwa-settings-row pwa-keyboard-setting" size="md" labelPosition="left" checked={enterSends} onChange={(event) => setEnterSends(event.currentTarget.checked)} label={s.enterSends} description={s.enterSendsHint} />
          <UnstyledButton className="pwa-settings-row pwa-settings-row-button" type="button" onClick={(event) => onShowShortcuts(event.currentTarget)} title={`${t.shortcuts.title} (${shortcutLabel("showHelp")})`}>
            <span className="pwa-settings-row-label">{t.shortcuts.title}</span>
            <ChevronRight className="pwa-settings-row-chevron" size={16} aria-hidden="true" />
          </UnstyledButton>
        </div>
        <p className="pwa-settings-section-description pwa-settings-footnote">{s.keyboardHint}</p>
      </section>
      <section className="pwa-settings-section" aria-labelledby="pwa-connection-heading">
        <h2 id="pwa-connection-heading" className="pwa-settings-section-title">{s.connection}</h2>
        <form className="pwa-card pwa-settings-group pwa-settings-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <TextInput className="pwa-input pwa-field" label={s.relayUrl} value={value} onChange={(event) => setValue(event.target.value)} placeholder={defaultRelayUrl} spellCheck={false} autoCapitalize="none" autoCorrect="off" inputMode="url" />
          <Button type="submit" loading={saving}>{s.save}</Button>
        </form>
        <p className="pwa-settings-section-description pwa-settings-footnote">{s.relayUrlHint}</p>
      </section>
      <section className="pwa-settings-section" aria-labelledby="pwa-browser-data-heading">
        <h2 id="pwa-browser-data-heading" className="pwa-settings-section-title">{s.browserData}</h2>
        <div className="pwa-card pwa-settings-group pwa-settings-group-actions">
          <Button variant="default" className="pwa-layout-reset-button" type="button" leftSection={<RotateCcw size={16} />} onClick={onResetLayout}>{s.resetLayout}</Button>
          <Button variant="outline" type="button" leftSection={<Trash2 size={16} />} onClick={onClearData}>{s.clearData}</Button>
        </div>
        <p className="pwa-settings-section-description pwa-settings-footnote">{s.localOnlyNote}</p>
        <p className="pwa-settings-section-description pwa-settings-footnote">{s.resetLayoutNote}</p>
      </section>
      {viewportDiagnostics ? <ViewportDiagnosticsSettings online={viewportDiagnosticsOnline} /> : null}
      <section className="pwa-settings-section" aria-labelledby="pwa-about-heading">
        <div className="pwa-settings-about-heading">
          <h2 id="pwa-about-heading" className="pwa-settings-section-title">{s.about}</h2>
          <CopyButton text={versionInfo} label={s.copyVersionInfo} />
        </div>
        <dl className="pwa-card pwa-settings-group pwa-settings-versions">
          <div className="pwa-settings-row"><dt>PWA</dt><dd data-version="pwa">{pwaVersion}</dd></div>
          <div className="pwa-settings-row"><dt>Relay</dt><dd data-version="relay">{relayVersionText}</dd></div>
          <div className="pwa-settings-row"><dt>{s.extension}</dt><dd data-version="extension">{extensionVersionText}</dd></div>
        </dl>
        {extensionTarget ? <p className="pwa-settings-section-description pwa-settings-footnote">{s.currentPi(extensionTarget)}</p> : null}
      </section>
    </div>
  </div>;
}

/** 「应用」分区：只在浏览器标签页中可以安装时出现，安装后整个分区随之消失（ADR-20261106「安装引导」）。 */
function InstallSettingsSection() {
  const { offer, install } = usePwaInstall();
  if (!offer) return null;
  return <InstallSettingsContent offer={offer} onInstall={async () => {
    await install();
    // 安装按钮随分区卸载，焦点交还页面标题，读屏从页首继续。
    document.getElementById("pwa-settings-title")?.focus({ preventScroll: true });
  }} />;
}

function InstallSettingsContent({ offer, onInstall }: { offer: InstallOffer; onInstall: () => Promise<void> }) {
  const n = useI18n().t.install;
  const { title, lead } = useInstallCopy(offer);
  return <section className="pwa-settings-section" aria-labelledby="pwa-install-heading">
    <h2 id="pwa-install-heading" className="pwa-settings-section-title">{n.settingsSection}</h2>
    <div className="pwa-card pwa-settings-group pwa-settings-install">
      <span className="pwa-settings-choice-text"><strong>{title}</strong><small>{lead}</small></span>
      {offer === "prompt"
        ? <Button variant="default" type="button" leftSection={<Download size={16} />} onClick={() => void onInstall()}>{n.install}</Button>
        : <InstallSteps offer={offer} thenPair={false} />}
    </div>
    <p className="pwa-settings-section-description pwa-settings-footnote">{n.settingsHint}</p>
  </section>;
}

/** 分组列表中的单选行：行首为可见的单选圆点，其后为图标与主副文字（DESIGN「设置页」）。 */
function SettingsChoice({ value, icon, title, hint, lang }: { value: string; icon: ReactNode; title: string; hint: string; lang?: string }) {
  return <Radio className="pwa-settings-row pwa-settings-choice" value={value} label={<span className="pwa-settings-choice-copy">
    {icon}
    <span className="pwa-settings-choice-text"><strong lang={lang}>{title}</strong><small>{hint}</small></span>
    <Check className="pwa-settings-choice-check" size={20} aria-hidden="true" />
  </span>} />;
}

/** 语言选项的行首标记：Lucide 没有区分具体语言的图标，用该语言的文字代替，与图标同占 20 × 20。 */
function LanguageGlyph({ lang, children }: { lang: string; children: string }) {
  return <span className="pwa-settings-choice-glyph" lang={lang} aria-hidden="true">{children}</span>;
}

/** 字号选项的行首字母：三档用逐级增大的同一个 A 直接示意大小，与语言选项的文字标记同一做法。 */
function TextSizeGlyph({ size }: { size: "standard" | "large" | "xlarge" }) {
  return <span className="pwa-settings-choice-glyph" data-text-size={size} lang="en" aria-hidden="true">A</span>;
}
