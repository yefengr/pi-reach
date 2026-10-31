import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, NativeSelect } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";
import { usePwaAppearance, type PwaAppearance } from "@/components/pwa/pwa-appearance";
import { applyReviewMotion, createReviewColorSchemeManager } from "./review-runtime";
import { REVIEW_MOTION_OPTIONS, type ReviewMotionPresetId } from "./review-motion-presets";
import { UiStateMotionParams, UiStateMotionWorkspace } from "./ui-state-motion";
import { GALLERY_STATES, type GalleryState } from "./ui-state-fixtures";
import { UiStateWorkspace } from "./ui-state-workspace";
import { UiStateNavigation } from "./ui-state-navigation";
import { UiStateSurfaces, type GallerySurface } from "./ui-state-surfaces";
import { GALLERY_DEVICES } from "./ui-state-shell-fixtures";
import { readerFocusable } from "@/components/pwa/reader-shared";
import "./ui-states.css";

type GalleryMotion = { preset: ReviewMotionPresetId; slow: boolean };
const SLOW_MOTION_SCALE = 4;

function applyGalleryMotion(motion: GalleryMotion, reducedMotion: boolean) {
  // 减少动态效果优先：清除慢放与对比参数，回到全局媒体查询的取值。
  applyReviewMotion(reducedMotion ? {} : { preset: motion.preset, scale: motion.slow ? SLOW_MOTION_SCALE : 1 });
}

function GalleryContent({ motion, onMotionChange, reducedMotion }: { motion: GalleryMotion; onMotionChange: (next: GalleryMotion) => void; reducedMotion: boolean }) {
  const [state, setState] = useState<GalleryState>("thinking");
  const [region, setRegion] = useState("conversation");
  const [surface, setSurface] = useState<GallerySurface>(null);
  const [surfaceDevice, setSurfaceDevice] = useState(GALLERY_DEVICES[0]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOrigin = useRef<HTMLElement | null>(null);
  const changeSurface = (next: GallerySurface) => {
    if (next !== "confirm" && next !== "shortcuts") {
      if (next === "settings" && !settingsOpen && readerFocusable(document.activeElement)) settingsOrigin.current = document.activeElement;
      setSettingsOpen(next === "settings");
    }
    setSurface(next);
  };
  useLayoutEffect(() => {
    if (settingsOpen) {
      document.querySelector<HTMLHeadingElement>(".pwa-ui-states-settings .pwa-settings-title")?.focus({ preventScroll: true });
      return;
    }
    if (readerFocusable(document.activeElement)) return;
    const fallback = [settingsOrigin.current, ...document.querySelectorAll<HTMLElement>(".pwa-session-trigger, .pwa-nav-settings, .pwa-ui-states-surface-controls button")].find(readerFocusable);
    fallback?.focus({ preventScroll: true });
  }, [settingsOpen]);
  const [narrow, setNarrow] = useState(false);
  const { slow } = motion;
  const { appearance, setAppearance } = usePwaAppearance();
  const active = GALLERY_STATES.find(entry => entry.id === state)!;
  return <main className="pwa-root pwa-ui-states" data-state={state} data-region={region} data-surface={surface ?? undefined} data-settings-open={settingsOpen || undefined}>
    <header className="pwa-ui-states-header" inert={settingsOpen} aria-hidden={settingsOpen || undefined}>
      <div className="pwa-ui-states-heading"><h1>界面状态展厅</h1><p>仅本页内存演示，不连接 Pi / Relay，不保存设置或草稿。</p></div>
      <div className="pwa-ui-states-controls">
        <NativeSelect label="展示区域" value={region} onChange={event => setRegion(event.currentTarget.value)} data={[
          { value: "conversation", label: "对话、边界与连续流程" }, { value: "navigation", label: "导航与会话" }, { value: "surfaces", label: "设置、确认与反馈" },
          { value: "motion", label: "动效对比：发送、过程组与叠层" },
        ]} />
        <NativeSelect label="演示状态" value={state} onChange={event => setState(event.currentTarget.value as GalleryState)} data={GALLERY_STATES.map(entry => ({ value: entry.id, label: entry.label }))} />
        <NativeSelect label="外观 · 仅本页" value={appearance} onChange={event => setAppearance(event.currentTarget.value as PwaAppearance)} data={[{ value: "light", label: "浅色" }, { value: "dark", label: "深色" }, { value: "system", label: "跟随系统" }]} />
        <Button variant="default" aria-pressed={narrow} onClick={() => setNarrow(value => !value)}>{narrow ? "恢复自适应宽度" : "窄主区 · 760px"}</Button>
        <NativeSelect label="动效参数 · 仅本页" value={motion.preset} onChange={event => onMotionChange({ ...motion, preset: event.currentTarget.value as ReviewMotionPresetId })} data={REVIEW_MOTION_OPTIONS} />
        <Button variant="default" aria-pressed={slow} onClick={() => onMotionChange({ ...motion, slow: !slow })}>{slow ? "动画速度 · 0.25×" : "动画速度 · 1×"}</Button>
      </div>
      <p className="pwa-ui-states-note">{active.note} 窄主区仅限制容器宽度，不模拟手机视口。</p>
      <p className="pwa-ui-states-motion" role="status">系统减少动态效果：{reducedMotion ? "已开启，慢放与对比参数不生效" : "未开启"}。慢放仅影响动画，复制反馈与业务状态保持原时序。</p>
      <details className="pwa-ui-states-coverage">
        <summary>覆盖范围与操作说明</summary>
        <p>“演示状态”提供 {GALLERY_STATES.length} 组正式组件状态。连续流程使用“下一步”推进输出、工具完成与会话失效，可先写草稿并打开工具详情观察连续性。</p>
        <p>“导航与会话”补充电脑选择、在线 Pi、只读历史、侧栏与手机导航；“设置、确认与反馈”补充设置、配对码、重命名、确认、帮助与通知。选择、保存、重试和清理均只影响本页。</p>
        <p>这里展示当前正式组件；原生路由、真实连接、摄像头、安装与设备手势仍在测试环境验收。历史对照与 HTML 候选原型保留各自入口。</p>
      </details>
      {region === "motion" ? <UiStateMotionParams preset={motion.preset} /> : null}
    </header>
    <UiStateSurfaces surface={surface} onSurfaceChange={changeSurface} showControls={region === "surfaces" || region === "motion"} device={surfaceDevice} />
    <section className="pwa-ui-states-workspace" data-narrow={narrow || undefined} aria-label="真实组件演示工作区" inert={settingsOpen} aria-hidden={settingsOpen || undefined}>
      <UiStateNavigation enabled={region === "navigation"} settingsOpen={settingsOpen} onSceneChange={setState} onOpenSurface={(next, device) => { setSurfaceDevice(device ?? GALLERY_DEVICES[0]); changeSurface(next); }}>
        {region === "motion" ? <UiStateMotionWorkspace /> : <UiStateWorkspace state={state} />}
      </UiStateNavigation>
    </section>
  </main>;
}

export function UiStateGalleryPage() {
  const manager = useMemo(() => createReviewColorSchemeManager(), []);
  const [motion, setMotion] = useState<GalleryMotion>({ preset: "current", slow: false });
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", false);
  // Provider 的 Modal 时长与各组件在渲染时读取 token：切换时先写入根元素，再提交状态。
  const changeMotion = (next: GalleryMotion) => {
    applyGalleryMotion(next, reducedMotion);
    setMotion(next);
  };
  // 系统偏好变化时重算；与切换时的预先写入结果相同，重复写入无副作用。
  useLayoutEffect(() => { applyGalleryMotion(motion, reducedMotion); }, [motion, reducedMotion]);
  useEffect(() => () => applyReviewMotion({}), []);
  return <PwaUiProvider colorSchemeManager={manager}><GalleryContent motion={motion} onMotionChange={changeMotion} reducedMotion={reducedMotion} /></PwaUiProvider>;
}
