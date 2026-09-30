import { useRef, useState, type Ref } from "react";
import { Button, Radio, Stack, TextInput } from "@mantine/core";
import { ArrowLeft, Globe, Languages, Monitor, Moon, RefreshCw, Sun, Trash2 } from "lucide-react";
import { usePwaAppearance, type PwaAppearance } from "@/components/pwa/pwa-appearance";
import { setLanguagePreference, useI18n, type LanguagePreference } from "@/lib/i18n";

type SettingsPageProps = {
  relayUrl: string;
  defaultRelayUrl: string;
  onSave: (value: string) => Promise<void>;
  onBack: () => void;
  /** 返回按钮的可访问名称随来源为「返回导航」或「返回工作区」。 */
  backLabel: string;
  onClearData: () => void;
  onResetLayout: () => void;
  titleRef?: Ref<HTMLHeadingElement>;
};

/**
 * 独立设置页：不保留工作区侧栏，内容最大宽 640，分区间距 32。
 * 移动端返回箭头与标题同一行；桌面返回为带文字的按钮，标题在其下方。
 */
export function SettingsPage({ relayUrl, defaultRelayUrl, onSave, onBack, backLabel, onClearData, onResetLayout, titleRef }: SettingsPageProps) {
  const [value, setValue] = useState(relayUrl);
  const [saving, setSaving] = useState(false);
  const savePendingRef = useRef(false);
  const { appearance, setAppearance } = usePwaAppearance();
  const { t, preference } = useI18n();
  const s = t.settings;
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
      <section className="pwa-settings-section" aria-labelledby="pwa-language-heading">
        <h2 id="pwa-language-heading" className="pwa-settings-section-title">{s.language}</h2>
        <p className="pwa-settings-section-description">{s.languageHint}</p>
        <Radio.Group aria-label={s.language} className="pwa-appearance-options" name="pwa-language" value={preference} onChange={(next) => setLanguagePreference(next as LanguagePreference)}>
          <Stack gap="xs">
            <Radio className="pwa-appearance-option" value="system" label={<span className="pwa-appearance-copy"><Globe size={20} /><span><strong>{s.followBrowser}</strong><small>{s.followBrowserHint}</small></span></span>} />
            <Radio className="pwa-appearance-option" value="zh" label={<span className="pwa-appearance-copy"><Languages size={20} /><span><strong lang="zh-CN">{s.chinese}</strong><small>{s.chineseHint}</small></span></span>} />
            <Radio className="pwa-appearance-option" value="en" label={<span className="pwa-appearance-copy"><Languages size={20} /><span><strong lang="en">{s.english}</strong><small>{s.englishHint}</small></span></span>} />
          </Stack>
        </Radio.Group>
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
            <Button variant="default" className="pwa-layout-reset-button" type="button" leftSection={<RefreshCw size={16} />} onClick={onResetLayout}>{s.resetLayout}</Button>
            <p className="pwa-layout-reset-note">{s.resetLayoutNote}</p>
          </div>
          <Button variant="outline" color="red" type="button" leftSection={<Trash2 size={16} />} onClick={onClearData}>{s.clearData}</Button>
        </div>
      </section>
    </div>
  </div>;
}
