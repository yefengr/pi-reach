import { useSyncExternalStore } from "react";
import { Radio, Stack } from "@mantine/core";
import { Gauge, Sparkles, Waves } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { getMotionProfile, setMotionProfile, subscribeMotionProfile, type PwaMotionProfile } from "@/lib/ui/motion-profile";

/** 评估期临时设置项：定稿后连同 motion-profile 与主题中的风格覆盖一起删除。 */
export function MotionProfileSettings() {
  const { t } = useI18n();
  const s = t.settings.motionProfile;
  const profile = useSyncExternalStore(subscribeMotionProfile, getMotionProfile, getMotionProfile);
  return <section className="pwa-settings-section" aria-labelledby="pwa-motion-profile-heading">
    <h2 id="pwa-motion-profile-heading" className="pwa-settings-section-title">{s.title}</h2>
    <p className="pwa-settings-section-description">{s.hint}</p>
    <Radio.Group aria-label={s.title} className="pwa-appearance-options" name="pwa-motion-profile" value={profile} onChange={(next) => setMotionProfile(next as PwaMotionProfile)}>
      <Stack gap="xs">
        <Radio className="pwa-appearance-option" value="spring" label={<span className="pwa-appearance-copy"><Sparkles size={20} /><span><strong>{s.spring}</strong><small>{s.springHint}</small></span></span>} />
        <Radio className="pwa-appearance-option" value="symmetric" label={<span className="pwa-appearance-copy"><Waves size={20} /><span><strong>{s.symmetric}</strong><small>{s.symmetricHint}</small></span></span>} />
        <Radio className="pwa-appearance-option" value="decelerate" label={<span className="pwa-appearance-copy"><Gauge size={20} /><span><strong>{s.decelerate}</strong><small>{s.decelerateHint}</small></span></span>} />
      </Stack>
    </Radio.Group>
  </section>;
}
