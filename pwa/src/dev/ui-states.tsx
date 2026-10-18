import { useEffect, useMemo, useState } from "react";
import { Button, NativeSelect } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";
import { usePwaAppearance, type PwaAppearance } from "@/components/pwa/pwa-appearance";
import { applyReviewSlowMotion, createReviewColorSchemeManager } from "./review-runtime";
import { GALLERY_STATES, type GalleryState } from "./ui-state-fixtures";
import { UiStateWorkspace } from "./ui-state-workspace";
import "./ui-states.css";

function GalleryContent() {
  const [state, setState] = useState<GalleryState>("thinking");
  const [narrow, setNarrow] = useState(false);
  const [slow, setSlow] = useState(false);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", false);
  const { appearance, setAppearance } = usePwaAppearance();
  useEffect(() => {
    applyReviewSlowMotion(slow && !reducedMotion ? 4 : 1);
    return () => applyReviewSlowMotion(1);
  }, [slow, reducedMotion]);
  const active = GALLERY_STATES.find(entry => entry.id === state)!;
  return <main className="pwa-root pwa-ui-states" data-state={state}>
    <header className="pwa-ui-states-header">
      <div className="pwa-ui-states-heading"><h1>界面状态展厅</h1><p>仅本页内存演示，不连接 Pi / Relay，不保存设置或草稿。</p></div>
      <div className="pwa-ui-states-controls">
        <NativeSelect label="演示状态" value={state} onChange={event => setState(event.currentTarget.value as GalleryState)} data={GALLERY_STATES.map(entry => ({ value: entry.id, label: entry.label }))} />
        <NativeSelect label="外观 · 仅本页" value={appearance} onChange={event => setAppearance(event.currentTarget.value as PwaAppearance)} data={[{ value: "light", label: "浅色" }, { value: "dark", label: "深色" }, { value: "system", label: "跟随系统" }]} />
        <Button variant="default" aria-pressed={narrow} onClick={() => setNarrow(value => !value)}>{narrow ? "恢复自适应宽度" : "窄主区 · 760px"}</Button>
        <Button variant="default" aria-pressed={slow} onClick={() => setSlow(value => !value)}>{slow ? "动画速度 · 0.25×" : "动画速度 · 1×"}</Button>
      </div>
      <p className="pwa-ui-states-note">{active.note} 窄主区仅限制容器宽度，不模拟手机视口。</p>
      <p className="pwa-ui-states-motion" role="status">系统减少动态效果：{reducedMotion ? "已开启，慢放不生效" : "未开启"}。慢放仅影响动画，复制反馈与业务状态保持原时序。</p>
    </header>
    <section className="pwa-ui-states-workspace" data-narrow={narrow || undefined} aria-label="真实组件演示工作区">
      <UiStateWorkspace state={state} />
    </section>
  </main>;
}

export function UiStateGalleryPage() {
  const manager = useMemo(() => createReviewColorSchemeManager(), []);
  return <PwaUiProvider colorSchemeManager={manager}><GalleryContent /></PwaUiProvider>;
}
