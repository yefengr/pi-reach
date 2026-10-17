import { useEffect, useRef, useState } from "react";
import { Button, Menu, type MantineColorScheme, type MantineColorSchemeManager } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { MessageComposer } from "@/components/pwa/message-composer";
import { ComposerModelSettingsMenuPanel, type ComposerModelSettingsView } from "@/components/pwa/composer-command-menu";
import { CopyButton } from "@/components/pwa/copy-button";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";
import { usePwaAppearance } from "@/components/pwa/pwa-appearance";
import { PwaOperationNotifications, PwaToastProvider } from "@/components/pwa/pwa-operation-notifications";
import { pwaFadeTransition, usePwaMotionDuration } from "@/components/pwa/use-pwa-motion";
import { createOperationNotificationController } from "@/lib/pwa/operation-notifications";
import { useFloatingSafeMiddlewares } from "@/lib/ui/safe-area";
import type { ThinkingLevel, WireModel } from "@/lib/pi-reach/types";
import { UI_REVIEW_CODE, UI_REVIEW_DRAFT, UI_REVIEW_MODELS, UI_REVIEW_TEXT } from "./ui-review-fixtures";
import "./ui-review.css";

type Variant = "baseline" | "candidate" | "deepseek";
type Layout = "switch" | "compare";
type CopyContent = "text" | "code";

const VARIANTS: { id: Variant; label: string; copyFeedback: "toast" | "inline" | "inline-text"; note: string }[] = [
  { id: "baseline", label: "当前版", copyFeedback: "toast", note: "阶段 A 基线（保留作对照）：输入区无阴影、12px 圆角，聚焦只改边框；菜单统一 44px 行高；复制显示对勾与成功 Toast。" },
  { id: "candidate", label: "原候选", copyFeedback: "inline", note: "原候选：输入区 16px 圆角常驻轻投影，聚焦只改边框；细指针菜单行高 40px；复制把对勾与读屏文字分开，失败说明直接顶替读屏文字。" },
  { id: "deepseek", label: "DS 候选", copyFeedback: "inline-text", note: "DS 候选：输入区 14px 圆角用底部落地边而非常驻投影，聚焦改为外扩光晕并浮出工具栏分隔；细指针菜单 36px 密集行、连续列表与更多可视行，粗指针 44px 并锁住滚动链；复制保留对勾交叠淡入与可见结果文字，按钮名称不随状态变化。" },
];

/** 三列共用同一份状态：任一列输入、选择或演示发送都同步到其它列，避免内容差异干扰判断。 */
type ReviewState = {
  draft: string;
  setDraft: (value: string) => void;
  model: WireModel;
  setModel: (model: WireModel) => void;
  thinking: ThinkingLevel;
  setThinking: (thinking: ThinkingLevel) => void;
  result: string;
  setResult: (value: string) => void;
  copyContent: CopyContent;
  setCopyContent: (value: CopyContent) => void;
  pinMenus: boolean;
};

function createReviewColorSchemeManager(): MantineColorSchemeManager {
  let value: MantineColorScheme = "light";
  return {
    get: () => value,
    set: (next) => { value = next; },
    // 仅供本页使用，没有需要向 Mantine 回传的外部变化。
    subscribe: () => {},
    unsubscribe: () => {},
    clear: () => { value = "light"; },
  };
}

function ReviewModelMenu({ variant, model, thinking, onModel, onThinking, pinOpened = false }: {
  variant: Variant;
  model: WireModel;
  thinking: ThinkingLevel;
  onModel: (model: WireModel) => void;
  onThinking: (thinking: ThinkingLevel) => void;
  /** 横向对比时把三份菜单同时固定展开，否则只能一次看一版。 */
  pinOpened?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const [view, setView] = useState<ComposerModelSettingsView>("settings");
  const duration = usePwaMotionDuration("--pwa-duration-fade", 120);
  const middlewares = useFloatingSafeMiddlewares();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [returnFocus, setReturnFocus] = useState(true);
  const shown = pinOpened || opened;
  useEffect(() => {
    if (!opened || pinOpened) return;
    const routeKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !(event.target instanceof Node)) return;
      const inDropdown = dropdownRef.current?.contains(event.target);
      const atTrigger = triggerRef.current?.contains(event.target);
      // 指针切换子视图会卸载原菜单项，浏览器可能将焦点暂放回 body。
      if (!inDropdown && !atTrigger && event.target !== document.body) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpened(false);
        triggerRef.current?.focus({ preventScroll: true });
      } else if (event.key === "Tab") {
        setReturnFocus(false);
        // 从触发器继续浏览器原生 Tab 顺序；关闭过渡不把焦点拉回。
        if (inDropdown || event.target === document.body) triggerRef.current?.focus({ preventScroll: true });
        setOpened(false);
      }
    };
    document.addEventListener("keydown", routeKey, true);
    return () => document.removeEventListener("keydown", routeKey, true);
  }, [opened, pinOpened]);
  const panel = <ComposerModelSettingsMenuPanel view={view} isOnline pendingAction={null} models={UI_REVIEW_MODELS}
    modelsStatus="success" currentModel={model} currentModelFallback={null} thinking={thinking}
    onSetModel={onModel} onSetThinking={onThinking} onBack={() => setView("settings")}
    onOpenModels={() => setView("models")} onOpenThinking={() => setView("thinking")} />;
  return <Menu opened={shown} onChange={(next) => { if (pinOpened) return; setOpened(next); if (next) { setReturnFocus(true); setView("settings"); } }}
    withinPortal portalProps={{ target: ".pwa-root" }} position="bottom-start" offset={8}
    width="var(--pwa-command-menu-width)" middlewares={middlewares} floatingStrategy="fixed" zIndex={8}
    returnFocus={pinOpened ? false : returnFocus} closeOnClickOutside={!pinOpened} closeOnEscape={!pinOpened}
    // 子视图会从短列表增长为长列表，不能沿用打开时锁定的方向而裁掉底部选项。
    preventPositionChangeWhenVisible={false} trapFocus={false} menuItemTabIndex={0}
    transitionProps={{ transition: pwaFadeTransition, duration }}>
    <Menu.Target><Button ref={triggerRef} className="pwa-review-menu-trigger" variant="default">打开模型与思考菜单</Button></Menu.Target>
    {/* 浮层经 Portal 离开列容器，携带 data-variant 让密度规则仍按版本生效。 */}
    <Menu.Dropdown ref={dropdownRef} className="pwa-command-menu-dropdown pwa-review-menu" data-variant={variant} inert={!shown} aria-label="演示模型与思考菜单">
      {panel}
    </Menu.Dropdown>
  </Menu>;
}

function ComposerSpecimen({ variant, state }: { variant: Variant; state: ReviewState }) {
  return <div className="pwa-review-specimen" data-testid={`review-composer-${variant}`}>
    <MessageComposer enterSends={true} attachments={[]} canAttach={false} sendingAttachments={false} isOnline isWorking={false} stopping={false}
      draft={state.draft} onDraftChange={state.setDraft} onSend={() => state.setResult(`演示发送（不会发送到 Pi）：${state.draft}`)}
      onStop={() => {}} onAddFiles={() => {}} onRemoveAttachment={() => {}} onRetryAttachment={() => {}}
      commandModels={UI_REVIEW_MODELS} commandModelsStatus="success" commandCurrentModel={state.model} commandCurrentModelFallback={null}
      commandThinking={state.thinking} commandPendingAction={null} onSetModel={state.setModel} onSetThinking={state.setThinking}
      onCommandsOpen={() => {}} onNewSession={() => state.setResult("演示新会话：不会创建真实 Pi 会话；草稿保持不变。")}
      onCompactSession={() => state.setResult("演示压缩：不会对 Pi 执行任何操作。")} />
    <p className="pwa-review-result" role="status">{state.result}</p>
  </div>;
}

function MenuSpecimen({ variant, state }: { variant: Variant; state: ReviewState }) {
  return <div className="pwa-review-specimen" data-testid={`review-menu-${variant}`}>
    <ReviewModelMenu variant={variant} pinOpened={state.pinMenus} model={state.model} thinking={state.thinking} onModel={state.setModel} onThinking={state.setThinking} />
    <p className="pwa-review-result" data-testid={`review-selection-${variant}`}>演示选择（仅本页）：{state.model.provider} / {state.model.name} · {state.thinking}</p>
  </div>;
}

function CopySpecimen({ variant, state }: { variant: Variant; state: ReviewState }) {
  const feedback = VARIANTS.find((entry) => entry.id === variant)!.copyFeedback;
  return <div className="pwa-review-specimen" data-testid={`review-copy-${variant}`}>
    <div className="pwa-review-copy-controls" role="group" aria-label="复制内容">
      <Button variant="default" aria-pressed={state.copyContent === "text"} onClick={() => state.setCopyContent("text")}>中文长文</Button>
      <Button variant="default" aria-pressed={state.copyContent === "code"} onClick={() => state.setCopyContent("code")}>代码片段</Button>
      <CopyButton key={`${variant}-${state.copyContent}`} text={state.copyContent === "text" ? UI_REVIEW_TEXT : UI_REVIEW_CODE} label="复制试件" feedback={feedback} className="pwa-review-copy" />
    </div>
    {state.copyContent === "code"
      ? <pre className="pwa-review-code"><code>{UI_REVIEW_CODE}</code></pre>
      : <p className="pwa-review-copy-text">{UI_REVIEW_TEXT}</p>}
  </div>;
}

function UiReviewContent() {
  const [layout, setLayout] = useState<Layout>("switch");
  const [variant, setVariant] = useState<Variant>("baseline");
  const [width, setWidth] = useState<"wide" | "narrow">("wide");
  const [draft, setDraft] = useState(UI_REVIEW_DRAFT);
  const [model, setModel] = useState(UI_REVIEW_MODELS[0]);
  const [thinking, setThinking] = useState<ThinkingLevel>("medium");
  const [result, setResult] = useState("尚未演示发送。不会发送到 Pi。");
  const [copyContent, setCopyContent] = useState<CopyContent>("text");
  const [pinMenus, setPinMenus] = useState(false);
  const [controller, setController] = useState(createOperationNotificationController);
  const { appearance, setAppearance } = usePwaAppearance();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", false);
  const active = VARIANTS.find((entry) => entry.id === variant)!;
  const state: ReviewState = { draft, setDraft, model, setModel, thinking, setThinking, result, setResult, copyContent, setCopyContent, pinMenus };
  const changeVariant = (next: Variant) => {
    if (variant === next) return;
    // 更换隔离实例，旧剪贴板 Promise 或 Toast 回调不能污染另一版反馈。
    controller.dispose();
    setController(createOperationNotificationController());
    setVariant(next);
  };
  const changeLayout = (next: Layout) => {
    if (layout === next) return;
    // 横向对比里可能同时开着三份菜单与三份复制反馈，切换布局时一并复位。
    controller.dispose();
    setController(createOperationNotificationController());
    setPinMenus(false);
    setLayout(next);
  };
  return <PwaToastProvider value={controller}>
    <div className="pwa-root pwa-ui-review" data-variant={layout === "switch" ? variant : undefined} data-layout={layout} data-review-width={width} data-review-appearance={appearance}>
      <main className="pwa-review-scroll">
        <div className="pwa-review-layout">
          <header className="pwa-review-header">
            <p className="pwa-review-eyebrow">Pi Reach · 阶段 A / 本地实验台</p>
            <h1>真实组件对照</h1>
            <p>同一套试件、同一视口、同一组演示数据：可单栏切换，也可三版横向并排。不连接 Relay 或 Pi，不保存草稿、外观或演示选择。</p>
            <div className="pwa-review-controls" role="group" aria-label="对照控制">
              <div role="group" aria-label="对照方式">
                <Button variant="default" aria-pressed={layout === "switch"} onClick={() => changeLayout("switch")}>单栏切换</Button>
                <Button variant="default" aria-pressed={layout === "compare"} onClick={() => changeLayout("compare")}>横向对比</Button>
              </div>
              {layout === "switch"
                ? <div role="group" aria-label="版本">
                  {VARIANTS.map((entry) => <Button key={entry.id} variant="default" aria-pressed={variant === entry.id} onClick={() => changeVariant(entry.id)}>{entry.label}</Button>)}
                </div>
                : <div role="group" aria-label="菜单">
                  <Button variant="default" aria-pressed={pinMenus} onClick={() => setPinMenus(!pinMenus)}>三版菜单同时展开</Button>
                </div>}
              <div role="group" aria-label="明暗">
                <Button variant="default" aria-pressed={appearance === "light"} onClick={() => setAppearance("light")}>浅色</Button>
                <Button variant="default" aria-pressed={appearance === "dark"} onClick={() => setAppearance("dark")}>深色</Button>
              </div>
              <div role="group" aria-label="试件宽度">
                <Button variant="default" aria-pressed={width === "wide"} onClick={() => setWidth("wide")}>宽 · 680</Button>
                <Button variant="default" aria-pressed={width === "narrow"} onClick={() => setWidth("narrow")}>窄 · 320</Button>
              </div>
            </div>
            <p className="pwa-review-note" data-testid="review-variant-note">{layout === "switch" ? active.note : "三列列宽相同、内容同步：在任一列输入或选择模型，三列一起变；复制与菜单各自独立触发，便于同时观察反馈。"}</p>
            <p className="pwa-review-note" data-testid="review-motion">系统减少动态效果：{reducedMotion ? "已生效" : "未启用"}。只跟随系统设置。</p>
            <p className="pwa-review-note"><a className="pwa-review-link" href="/app/ui-review-stage-a">阶段 A 剩余对照（当前版 vs 原候选：按压、菜单进入、附件卡片）→</a></p>
          </header>
          {layout === "switch" ? <>
            <section className="pwa-review-section" aria-labelledby="review-composer-title">
              <h2 id="review-composer-title">01 / 输入区层次</h2>
              <p className="pwa-review-note">真实 MessageComposer。切换版本保留输入；附件本轮禁用，命令与发送仅在此页模拟。聚焦后对比轮廓、投影与工具栏分隔。</p>
              <ComposerSpecimen variant={variant} state={state} />
            </section>
            <section className="pwa-review-section" aria-labelledby="review-menu-title">
              <h2 id="review-menu-title">02 / 菜单密度</h2>
              <p className="pwa-review-note">真实模型面板：长列表、完整长名称、返回、选择与键盘关闭。三版都按输入方式分层；原候选细指针 40px，DS 候选 36px 并把行内留白改为上下左右对称。</p>
              <MenuSpecimen variant={variant} state={state} />
            </section>
            <section className="pwa-review-section" aria-labelledby="review-copy-title">
              <h2 id="review-copy-title">03 / 复制反馈</h2>
              <p className="pwa-review-note">三版都等待真实剪贴板结果、都不移动按钮。当前版用 Toast；原候选只换图标并把结果放进读屏区域；DS 候选额外给出可见结果文字，按钮名称保持不变。</p>
              <CopySpecimen variant={variant} state={state} />
            </section>
          </> : <section className="pwa-review-section" aria-labelledby="review-compare-title">
            <h2 id="review-compare-title">三版横向对比</h2>
            <p className="pwa-review-note">同一类试件占一行、三版各占一列，同行顶部对齐。三列共用同一份草稿、模型、思考级别与结果行，列宽相同。菜单可点「三版菜单同时展开」一起看密度；复制在 2 秒窗口内依次点击，即可同屏对比反馈。窄屏可横向滚动查看三列。</p>
            <div className="pwa-review-compare-grid">
              {VARIANTS.map((entry) => <div key={entry.id} className="pwa-review-compare-head" data-testid={`review-column-${entry.id}`} data-variant={entry.id} data-review-appearance={appearance}>
                <h3>{entry.label}</h3>
                <p className="pwa-review-note">{entry.note}</p>
              </div>)}
              <h4 className="pwa-review-compare-row" id="review-compare-composer">01 / 输入区层次</h4>
              {VARIANTS.map((entry) => <div key={`composer-${entry.id}`} className="pwa-review-compare-cell" data-testid={`review-composer-cell-${entry.id}`} data-variant={entry.id} data-review-appearance={appearance}>
                <ComposerSpecimen variant={entry.id} state={state} />
              </div>)}
              <h4 className="pwa-review-compare-row" id="review-compare-menu">02 / 菜单密度</h4>
              {VARIANTS.map((entry) => <div key={`menu-${entry.id}`} className="pwa-review-compare-cell" data-testid={`review-menu-cell-${entry.id}`} data-variant={entry.id} data-review-appearance={appearance}>
                <MenuSpecimen variant={entry.id} state={state} />
              </div>)}
              <h4 className="pwa-review-compare-row" id="review-compare-copy">03 / 复制反馈</h4>
              {VARIANTS.map((entry) => <div key={`copy-${entry.id}`} className="pwa-review-compare-cell" data-testid={`review-copy-cell-${entry.id}`} data-variant={entry.id} data-review-appearance={appearance}>
                <CopySpecimen variant={entry.id} state={state} />
              </div>)}
            </div>
          </section>}
        </div>
      </main>
      <PwaOperationNotifications controller={controller} />
    </div>
  </PwaToastProvider>;
}

export function UiReviewPage() {
  const [manager] = useState(createReviewColorSchemeManager);
  return <PwaUiProvider colorSchemeManager={manager}><UiReviewContent /></PwaUiProvider>;
}
