import { useRef, useState, type Ref } from "react";
import { Button, Radio, Stack, Switch, TextInput } from "@mantine/core";
import { ALargeSmall, ArrowLeft, CaseSensitive, Globe, Languages, Monitor, Moon, RotateCcw, Sun, Trash2, Type } from "lucide-react";
import { usePwaAppearance, type PwaAppearance } from "@/components/pwa/pwa-appearance";
import { usePwaTextSize } from "@/components/pwa/use-pwa-text-size";
import { setLanguagePreference, useI18n, type LanguagePreference } from "@/lib/i18n";
import type { PwaTextSize } from "@/lib/ui/text-size";
import { CopyButton } from "@/components/pwa/copy-button";
import { shortcutLabel, useEnterSends } from "@/lib/pwa/keyboard-shortcuts";
import type { ConnectionViewState } from "@/components/pwa/workspace-view";
import { version as pwaVersion } from "../../../package.json";

export type SettingsPagePreferences = {
  language: LanguagePreference;
  setLanguage: (value: LanguagePreference) => void;
  enterSends: boolean;
  setEnterSends: (value: boolean) => void;
};

type SettingsPageProps = {
  preferences?: SettingsPagePreferences;
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
 * 独立设置页：不保留工作区侧栏，内容最大宽 640，分区间距 32。
 * 移动端返回箭头与标题同一行；桌面返回为带文字的按钮，标题在其下方。
 */
export function SettingsPage({ preferences, ...props }: SettingsPageProps) {
  return preferences ? <SettingsPageContent {...props} preferences={preferences} /> : <PersistedSettingsPage {...props} />;
}

function PersistedSettingsPage(props: Omit<SettingsPageProps, "preferences">) {
  const { preference } = useI18n();
  const [enterSends, setEnterSends] = useEnterSends();
  return <SettingsPageContent {...props} preferences={{ language: preference, setLanguage: setLanguagePreference, enterSends, setEnterSends }} />;
}

function SettingsPageContent({ preferences, relayUrl, defaultRelayUrl, relayVersion, relayStatus, extensionVersion, extensionStatus, extensionTarget, onSave, onBack, backLabel, onClearData, onResetLayout, onShowShortcuts, titleRef }: Omit<SettingsPageProps, "preferences"> & { preferences: SettingsPagePreferences }) {
  const [value, setValue] = useState(relayUrl);
  const [saving, setSaving] = useState(false);
  const savePendingRef = useRef(false);
  const { appearance, setAppearance } = usePwaAppearance();
  const { textSize, setTextSize } = usePwaTextSize();
  const { t } = useI18n();
  const { enterSends, setEnterSends } = preferences;
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
        <Button className="pwa-settings-back" variant="transparent" color="piReach" type="button" onClick={onBack} aria-label={backLabel} title={backLabel} leftSection={<ArrowLeft size={20} aria-hidden="true" />}>
          <span className="pwa-settings-back-label">{backLabel}</span>
        </Button>
        <h1 id="pwa-settings-title" className="pwa-settings-title" ref={titleRef} tabIndex={-1}>{s.title}</h1>
      </header>
      <section className="pwa-settings-section" aria-labelledby="pwa-appearance-heading">
        <h2 id="pwa-appearance-heading" className="pwa-settings-section-title">{s.appearance}</h2>
        <p className="pwa-settings-section-description">{s.appearanceHint}</p>
        <Radio.Group aria-label={s.appearance} className="pwa-appearance-options" name="pwa-appearance" value={appearance} onChange={(next) => setAppearance(next as PwaAppearance)}>
          <Stack gap="xs">
            <Radio className="pwa-appearance-option" value="system" label={<span className="pwa-appearance-copy"><Monitor size={20} /><span><strong>{s.system}</strong><small>{s.systemHint}</small></span></span>} />
            <Radio className="pwa-appearance-option" value="light" label={<span className="pwa-appearance-copy"><Sun size={20} /><span><strong>{s.light}</strong><small>{s.lightHint}</small></span></span>} />
            <Radio className="pwa-appearance-option" value="dark" label={<span className="pwa-appearance-copy"><Moon size={20} /><span><strong>{s.dark}</strong><small>{s.darkHint}</small></span></span>} />
          </Stack>
        </Radio.Group>
      </section>
      <section className="pwa-settings-section" aria-labelledby="pwa-text-size-heading">
        <h2 id="pwa-text-size-heading" className="pwa-settings-section-title">{s.textSize}</h2>
        <p className="pwa-settings-section-description">{s.textSizeHint}</p>
        <Radio.Group aria-label={s.textSize} className="pwa-appearance-options" name="pwa-text-size" value={textSize} onChange={(next) => setTextSize(next as PwaTextSize)}>
          <Stack gap="xs">
            <Radio className="pwa-appearance-option" value="standard" label={<span className="pwa-appearance-copy"><Type size={20} /><span><strong>{s.textSizeStandard}</strong><small>{s.textSizeStandardHint}</small></span></span>} />
            <Radio className="pwa-appearance-option" value="large" label={<span className="pwa-appearance-copy"><ALargeSmall size={20} /><span><strong>{s.textSizeLarge}</strong><small>{s.textSizeLargeHint}</small></span></span>} />
            <Radio className="pwa-appearance-option" value="xlarge" label={<span className="pwa-appearance-copy"><CaseSensitive size={20} /><span><strong>{s.textSizeXLarge}</strong><small>{s.textSizeXLargeHint}</small></span></span>} />
          </Stack>
        </Radio.Group>
      </section>
      <section className="pwa-settings-section" aria-labelledby="pwa-language-heading">
        <h2 id="pwa-language-heading" className="pwa-settings-section-title">{s.language}</h2>
        <p className="pwa-settings-section-description">{s.languageHint}</p>
        <Radio.Group aria-label={s.language} className="pwa-appearance-options" name="pwa-language" value={preferences.language} onChange={(next) => preferences.setLanguage(next as LanguagePreference)}>
          <Stack gap="xs">
            <Radio className="pwa-appearance-option" value="system" label={<span className="pwa-appearance-copy"><Globe size={20} /><span><strong>{s.followBrowser}</strong><small>{s.followBrowserHint}</small></span></span>} />
            <Radio className="pwa-appearance-option" value="zh" label={<span className="pwa-appearance-copy"><Languages size={20} /><span><strong lang="zh-CN">{s.chinese}</strong><small>{s.chineseHint}</small></span></span>} />
            <Radio className="pwa-appearance-option" value="en" label={<span className="pwa-appearance-copy"><Languages size={20} /><span><strong lang="en">{s.english}</strong><small>{s.englishHint}</small></span></span>} />
          </Stack>
        </Radio.Group>
      </section>
      <section className="pwa-settings-section" aria-labelledby="pwa-keyboard-heading">
        <h2 id="pwa-keyboard-heading" className="pwa-settings-section-title">{s.keyboard}</h2>
        <p className="pwa-settings-section-description">{s.keyboardHint}</p>
        <div className="pwa-settings-actions">
          <Switch className="pwa-keyboard-setting" size="md" checked={enterSends} onChange={(event) => setEnterSends(event.currentTarget.checked)} label={s.enterSends} description={s.enterSendsHint} />
          <Button variant="default" type="button" onClick={(event) => onShowShortcuts(event.currentTarget)} title={`${t.shortcuts.title} (${shortcutLabel("showHelp")})`}>{t.shortcuts.title}</Button>
        </div>
      </section>
      <section className="pwa-settings-section" aria-labelledby="pwa-connection-heading">
        <h2 id="pwa-connection-heading" className="pwa-settings-section-title">{s.connection}</h2>
        <p className="pwa-settings-section-description">{s.relayUrlHint}</p>
        <form className="pwa-settings-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <TextInput className="pwa-input pwa-field" label={s.relayUrl} value={value} onChange={(event) => setValue(event.target.value)} placeholder={defaultRelayUrl} spellCheck={false} autoCapitalize="none" autoCorrect="off" inputMode="url" />
          <Button type="submit" loading={saving}>{s.save}</Button>
        </form>
      </section>
      <section className="pwa-settings-section" aria-labelledby="pwa-browser-data-heading">
        <h2 id="pwa-browser-data-heading" className="pwa-settings-section-title">{s.browserData}</h2>
        <p className="pwa-settings-section-description">{s.localOnlyNote}</p>
        <div className="pwa-settings-actions">
          <div>
            <Button variant="default" className="pwa-layout-reset-button" type="button" leftSection={<RotateCcw size={16} />} onClick={onResetLayout}>{s.resetLayout}</Button>
            <p className="pwa-layout-reset-note">{s.resetLayoutNote}</p>
          </div>
          <Button variant="outline" color="red" type="button" leftSection={<Trash2 size={16} />} onClick={onClearData}>{s.clearData}</Button>
        </div>
      </section>
      <section className="pwa-settings-section" aria-labelledby="pwa-about-heading">
        <div className="pwa-settings-about-heading">
          <h2 id="pwa-about-heading" className="pwa-settings-section-title">{s.about}</h2>
          <CopyButton text={versionInfo} label={s.copyVersionInfo} />
        </div>
        <dl className="pwa-settings-versions">
          <div><dt>PWA</dt><dd data-version="pwa">{pwaVersion}</dd></div>
          <div><dt>Relay</dt><dd data-version="relay">{relayVersionText}</dd></div>
          <div><dt>{s.extension}</dt><dd data-version="extension">{extensionVersionText}</dd></div>
        </dl>
        {extensionTarget ? <p className="pwa-settings-section-description pwa-settings-version-target">{s.currentPi(extensionTarget)}</p> : null}
      </section>
    </div>
  </div>;
}
