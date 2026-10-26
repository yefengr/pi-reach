import { useEffect, useRef, useState } from "react";
import { ActionIcon, Button, Menu, type MantineTransition } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { ArrowUp, Plus, Slash } from "lucide-react";
import { AttachmentCards } from "@/components/pwa/attachment-cards";
import { ComposerModelSettingsMenuPanel, type ComposerModelSettingsView } from "@/components/pwa/composer-command-menu";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";
import { usePwaAppearance } from "@/components/pwa/pwa-appearance";
import { pwaFadeTransition, usePwaMotionDuration } from "@/components/pwa/use-pwa-motion";
import { useFloatingSafeMiddlewares } from "@/lib/ui/safe-area";
import type { ThinkingLevel, WireModel } from "@/lib/pi-reach/types";
import { applyReviewSlowMotion, createReviewColorSchemeManager } from "./review-runtime";
import { UI_REVIEW_ATTACHMENTS, UI_REVIEW_MODELS } from "./ui-review-fixtures";
import "./ui-review.css";
import "./ui-review-stage-a.css";

type Variant = "baseline" | "candidate";

const VARIANTS: { id: Variant; label: string; note: string }[] = [
  { id: "baseline", label: "当前版", note: "现行实现：菜单纯淡入 120ms；按压只换底色，控件外形与尺寸不变；附件卡片用 panel 底、无投影。" },
  { id: "candidate", label: "原候选", note: "原候选方向：菜单从锚点缩放 0.98→1 并上移 2px（进入 150ms／退出 110ms）；按压时绘制层缩至 0.97、按下 90ms；附件卡片改为 surface 底加极轻抬升与 10px 圆角。" },
];

/** 候选菜单进入：从真实锚点缩放并轻微上移，缩放只作用于绘制层，不改变点击区。 */
const candidateMenuTransition = {
  in: { opacity: 1, transform: "scale(1) translateY(0)" },
  out: { opacity: 0, transform: "scale(0.98) translateY(2px)", pointerEvents: "none" },
  transitionProperty: "opacity, transform",
} as MantineTransition;

function ReviewMenu({ variant, model, thinking, onModel, onThinking }: {
  variant: Variant;
  model: WireModel;
  thinking: ThinkingLevel;
  onModel: (model: WireModel) => void;
  onThinking: (thinking: ThinkingLevel) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [view, setView] = useState<ComposerModelSettingsView>("settings");
  const fade = usePwaMotionDuration("--pwa-duration-fade");
  const middlewares = useFloatingSafeMiddlewares();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const candidate = variant === "candidate";
  return <Menu opened={opened} onChange={(next) => { setOpened(next); if (next) setView("settings"); }}
    withinPortal portalProps={{ target: ".pwa-root" }} position="bottom-start" offset={8}
    width="var(--pwa-command-menu-width)" middlewares={middlewares} floatingStrategy="fixed" zIndex={8}
    preventPositionChangeWhenVisible={false} trapFocus={false} closeOnEscape menuItemTabIndex={0}
    transitionProps={candidate
      ? { transition: candidateMenuTransition, duration: 150, exitDuration: 110, timingFunction: "var(--pwa-ease-enter)" }
      : { transition: pwaFadeTransition, duration: fade }}>
    <Menu.Target><Button ref={triggerRef} className="pwa-review-menu-trigger" variant="default" data-testid={`stage-a-menu-trigger-${variant}`}>打开模型与思考菜单</Button></Menu.Target>
    <Menu.Dropdown className="pwa-command-menu-dropdown pwa-stage-a-menu" data-variant={variant} data-testid={`stage-a-menu-${variant}`}
      aria-label="演示模型与思考菜单" style={candidate ? { transformOrigin: "top left" } : undefined}>
      <ComposerModelSettingsMenuPanel view={view} isOnline pendingAction={null} models={UI_REVIEW_MODELS}
        modelsStatus="success" currentModel={model} currentModelFallback={null} thinking={thinking}
        onSetModel={onModel} onSetThinking={onThinking} onBack={() => setView("settings")}
        onOpenModels={() => setView("models")} onOpenThinking={() => setView("thinking")} />
    </Menu.Dropdown>
  </Menu>;
}

function PressSpecimen({ variant }: { variant: Variant }) {
  return <div className="pwa-stage-a-press" data-testid={`stage-a-press-${variant}`}>
    <div className="pwa-composer-tools">
      <ActionIcon className="pwa-composer-icon" aria-label="添加附件" title="添加附件"><Plus size={20} /></ActionIcon>
      <ActionIcon className="pwa-composer-icon" aria-label="Pi 命令" title="Pi 命令"><Slash size={20} /></ActionIcon>
    </div>
    <div className="pwa-stage-a-buttons">
      <Button variant="default" data-testid={`stage-a-button-${variant}`}>文字按钮</Button>
      <ActionIcon className="pwa-composer-send" variant="filled" size={36} radius="xl" aria-label="发送消息" title="发送消息"><ArrowUp size={20} /></ActionIcon>
    </div>
  </div>;
}

function StageAContent() {
  const [slow, setSlow] = useState(false);
  const [surface, setSurface] = useState<"neutral" | "warm">("neutral");
  const [model, setModel] = useState(UI_REVIEW_MODELS[0]);
  const [thinking, setThinking] = useState<ThinkingLevel>("medium");
  const { appearance, setAppearance } = usePwaAppearance();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", false);

  useEffect(() => {
    // 系统减少动态效果优先，不能让评审慢放把短淡化拉长。
    applyReviewSlowMotion(slow && !reducedMotion ? 4 : 1);
    return () => { applyReviewSlowMotion(1); };
  }, [slow, reducedMotion]);

  return <div className="pwa-root pwa-ui-review pwa-stage-a" data-layout="compare" data-surface={surface} data-review-appearance={appearance}>
    <main className="pwa-review-scroll">
      <div className="pwa-review-layout">
        <header className="pwa-review-header">
          <p className="pwa-review-eyebrow">Pi Reach · 阶段 A 剩余对照 / 本地实验台</p>
          <h1>当前版 与 原候选</h1>
          <p>补做阶段 A 剩余对照：按压反馈、菜单进入、附件卡片层次。同一内容、同一列宽、同一操作条件；不连接 Relay 或 Pi，不保存外观、慢放或演示选择。</p>
          <div className="pwa-review-controls" role="group" aria-label="对照控制">
            <div role="group" aria-label="明暗">
              <Button variant="default" aria-pressed={appearance === "light"} onClick={() => setAppearance("light")}>浅色</Button>
              <Button variant="default" aria-pressed={appearance === "dark"} onClick={() => setAppearance("dark")}>深色</Button>
            </div>
            <div role="group" aria-label="表面色">
              <Button variant="default" aria-pressed={surface === "neutral"} onClick={() => setSurface("neutral")}>中性灰</Button>
              <Button variant="default" aria-pressed={surface === "warm"} onClick={() => setSurface("warm")}>暖灰</Button>
            </div>
            <div role="group" aria-label="慢放">
              <Button variant="default" aria-pressed={!slow} onClick={() => setSlow(false)}>1×</Button>
              <Button variant="default" aria-pressed={slow} onClick={() => setSlow(true)}>0.25× 慢放</Button>
            </div>
          </div>
          <p className="pwa-review-note"><a className="pwa-review-link" href="/app/ui-review">← 返回三版对照（当前版 / 原候选 / DS 候选）</a></p>
          <p className="pwa-review-note" data-testid="stage-a-motion">系统减少动态效果：{reducedMotion ? "已生效" : "未启用"}。开启后位移与缩放改为 120ms 淡化；慢放只缩放时长，不改曲线与位移距离。</p>
        </header>

        <section className="pwa-review-section" aria-labelledby="stage-a-surface-title">
          <h2 id="stage-a-surface-title">00 / 表面色</h2>
          <p className="pwa-review-note">只替换中性表面色，字号、间距、布局、文字色与主色都不变。中性灰是现行基线；暖灰为方案 §4.2 要求的对照稿，两档都按现行对比度阈值实测通过。</p>
          <div className="pwa-stage-a-surface-sample" data-testid="stage-a-surface-sample">
            <p>长文判读样本：界面在长时间阅读时应保持安静清晰。切换表面色后，正文与元数据的对比度、行高、行长都与另一档完全一致，变化的只有底色温度。</p>
            <code>{"const surfaces = { neutral: rgb(247 247 247), warm: rgb(247 243 236) };"}</code>
            <small>元数据行 · 13px · secondary · 2026-10-17 · 仅用于本页对照</small>
          </div>
        </section>

        <section className="pwa-review-section" aria-labelledby="stage-a-press-title">
          <h2 id="stage-a-press-title">01 / 按压反馈</h2>
          <p className="pwa-review-note">真实 Mantine 控件：图标按钮按压时只缩放内部绘制层，文字按钮与发送圆钮缩放整块视觉，点击区与布局不变。按住不放可以看稳定状态。</p>
          <div className="pwa-review-compare-grid">
            {VARIANTS.map((entry) => <div key={`press-head-${entry.id}`} className="pwa-review-compare-head" data-variant={entry.id}>
              <h3>{entry.label}</h3>
              <p className="pwa-review-note">{entry.note}</p>
            </div>)}
            <h4 className="pwa-review-compare-row">同一组控件</h4>
            {VARIANTS.map((entry) => <div key={`press-${entry.id}`} className="pwa-review-compare-cell" data-variant={entry.id}>
              <div className="pwa-review-specimen"><PressSpecimen variant={entry.id} /></div>
            </div>)}
          </div>
        </section>

        <section className="pwa-review-section" aria-labelledby="stage-a-menu-title">
          <h2 id="stage-a-menu-title">02 / 菜单进入</h2>
          <p className="pwa-review-note">真实模型与思考面板：两列内容、宽度、锚点相同，只有进入与退出动效不同。行密度两列一致，避免同时比较两件事。</p>
          <div className="pwa-review-compare-grid">
            {VARIANTS.map((entry) => <div key={`menu-head-${entry.id}`} className="pwa-review-compare-head" data-variant={entry.id}>
              <h3>{entry.label} · 菜单</h3>
              <p className="pwa-review-note">{entry.id === "candidate" ? "缩放 0.98→1 + 上移 2px，进入 150ms、退出 110ms。" : "纯淡入 120ms，无缩放与位移。"}</p>
            </div>)}
            <h4 className="pwa-review-compare-row">同一菜单</h4>
            {VARIANTS.map((entry) => <div key={`menu-${entry.id}`} className="pwa-review-compare-cell" data-variant={entry.id}>
              <div className="pwa-review-specimen">
                <ReviewMenu variant={entry.id} model={model} thinking={thinking} onModel={setModel} onThinking={setThinking} />
                <p className="pwa-review-result">演示选择（仅本页）：{model.provider} / {model.name} · {thinking}</p>
              </div>
            </div>)}
          </div>
        </section>

        <section className="pwa-review-section" aria-labelledby="stage-a-attachment-title">
          <h2 id="stage-a-attachment-title">03 / 附件卡片层次</h2>
          <p className="pwa-review-note">真实 AttachmentCards，六种状态同一批内容。当前版用 panel 底与细边界；原候选改用 surface 底、极轻抬升与 10px 圆角。两列卡片高度与 44px 操作槽必须一致。</p>
          <div className="pwa-review-compare-grid">
            {VARIANTS.map((entry) => <div key={`attachment-head-${entry.id}`} className="pwa-review-compare-head" data-variant={entry.id}>
              <h3>{entry.label} · 附件</h3>
              <p className="pwa-review-note">{entry.id === "candidate" ? "surface 底 + 0 1px 2px 轻阴影，悬停边界加深；深色不加投影。" : "panel 底 + 1px line 边界，无投影。"}</p>
            </div>)}
            <h4 className="pwa-review-compare-row">同一批附件</h4>
            {VARIANTS.map((entry) => <div key={`attachment-${entry.id}`} className="pwa-review-compare-cell" data-variant={entry.id}>
              <div className="pwa-review-specimen" data-testid={`stage-a-attachments-${entry.id}`}>
                <AttachmentCards items={UI_REVIEW_ATTACHMENTS} disabled onRemove={() => {}} onRetry={() => {}} />
              </div>
            </div>)}
          </div>
        </section>
      </div>
    </main>
  </div>;
}

export function UiReviewStageAPage() {
  const [manager] = useState(createReviewColorSchemeManager);
  return <PwaUiProvider colorSchemeManager={manager}><StageAContent /></PwaUiProvider>;
}
