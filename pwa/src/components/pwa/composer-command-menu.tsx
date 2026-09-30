import { useLayoutEffect, useRef, useState } from "react";
import { Menu } from "@mantine/core";
import { ArrowLeft, Check, ChevronRight, Cpu, FilePlus2, Gauge, Minimize2 } from "lucide-react";
import type { ThinkingLevel, WireModel } from "@/lib/pi-reach/types";
import { useI18n } from "@/lib/i18n";

export type ComposerCommandAction = "session_new" | "session_compact" | "model_set" | "thinking_set";
export type ComposerCommandMenuView = "root" | "models" | "thinking";
export type ComposerCommandMenuPresentation = "command" | "action";

export const COMPOSER_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ThinkingLevel[];

type ComposerCommandMenuCallbacks = {
  onNewSession: () => void;
  onCompactSession: () => void;
  onSetModel: (model: WireModel) => void;
  onSetThinking: (level: ThinkingLevel) => void;
};

export type ComposerCommandMenuPanelProps = ComposerCommandMenuCallbacks & {
  view: ComposerCommandMenuView;
  isOnline: boolean;
  isWorking: boolean;
  pendingAction: ComposerCommandAction | null;
  models: WireModel[];
  currentModel: WireModel | null;
  currentModelFallback: string | null;
  thinking: ThinkingLevel;
  onBack: () => void;
  onOpenModels: () => void;
  onOpenThinking: () => void;
  presentation?: ComposerCommandMenuPresentation;
  /** 会话「更多」菜单不重复模型与思考级别，它们只从输入区进入。 */
  showModelControls?: boolean;
};

export type ComposerCommandMenuProps = Omit<ComposerCommandMenuPanelProps, "view" | "onBack" | "onOpenModels" | "onOpenThinking"> & {
  opened: boolean;
  /** 打开时的起始视图：「/」入口从根视图开始，输入区的模型标签直接进入模型列表。 */
  initialView?: ComposerCommandMenuView;
};

function modelLabel(model: WireModel): string {
  return `${model.provider} / ${model.name}`;
}

function isCurrentModel(model: WireModel, currentModel: WireModel | null): boolean {
  return currentModel?.provider === model.provider && currentModel.id === model.id;
}

function useCommandViewFocus(view: ComposerCommandMenuView) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const focusTargetRef = useRef<ComposerCommandMenuView | null>(null);
  const changeView = (target: ComposerCommandMenuView, callback: () => void) => {
    // 只补救视图切换中即将卸载的菜单项焦点；指针打开时不抢触发器焦点。
    focusTargetRef.current = panelRef.current?.contains(document.activeElement) ? target : null;
    callback();
  };
  useLayoutEffect(() => {
    const target = focusTargetRef.current;
    focusTargetRef.current = null;
    const panel = panelRef.current;
    if (!target || !panel) return;
    const preferred = panel.querySelector<HTMLButtonElement>(`[data-command-view="${target}"]`);
    const dropdown = panel.closest<HTMLElement>("[data-menu-dropdown]");
    const fallback = dropdown?.querySelector<HTMLButtonElement>("[data-menu-item]:not(:disabled)");
    const next = preferred && !preferred.disabled ? preferred : fallback ?? dropdown;
    next?.focus({ preventScroll: true });
  }, [view]);
  return { panelRef, changeView };
}

export function ComposerCommandMenuPanel({
  view,
  isOnline,
  isWorking,
  pendingAction,
  models,
  currentModel,
  currentModelFallback,
  thinking,
  onNewSession,
  onCompactSession,
  onSetModel,
  onSetThinking,
  onBack,
  onOpenModels,
  onOpenThinking,
  presentation = "command",
  showModelControls = true,
}: ComposerCommandMenuPanelProps) {
  const { t } = useI18n();
  const c = t.commands;
  const { panelRef, changeView } = useCommandViewFocus(view);
  const actionDisabled = !isOnline || pendingAction !== null;
  const newSessionDisabled = actionDisabled || isWorking;
  const currentModelLabel = currentModel
    ? modelLabel(currentModel)
    : currentModelFallback || c.currentModelUnavailable;

  if (view === "models") {
    return <div ref={panelRef} className="pwa-command-menu-panel" role="group" aria-label={c.changeModel}>
      <Menu.Item className="pwa-command-back" data-command-view="root" leftSection={<ArrowLeft size={16} />} closeMenuOnClick={false} onClick={() => changeView("models", onBack)}>{t.common.back}</Menu.Item>
      <Menu.Label className="pwa-command-menu-heading">{c.changeModel}</Menu.Label>
      {models.length ? models.map((model) => {
        const selected = isCurrentModel(model, currentModel);
        return <Menu.Item className="pwa-command-row pwa-command-choice" data-selected={selected || undefined} key={`${model.provider}:${model.id}`} disabled={actionDisabled} leftSection={<Cpu size={16} />} rightSection={selected ? <Check className="pwa-command-check" size={16} aria-label={c.currentModel} /> : null} onClick={() => onSetModel(model)}>
          <span className="pwa-command-copy"><span>{modelLabel(model)}</span><small>{model.id}</small></span>
        </Menu.Item>;
      }) : <p className="pwa-command-empty">{c.noModels}</p>}
    </div>;
  }

  if (view === "thinking") {
    return <div ref={panelRef} className="pwa-command-menu-panel" role="group" aria-label={c.thinkingLevel}>
      <Menu.Item className="pwa-command-back" data-command-view="root" leftSection={<ArrowLeft size={16} />} closeMenuOnClick={false} onClick={() => changeView("thinking", onBack)}>{t.common.back}</Menu.Item>
      <Menu.Label className="pwa-command-menu-heading">{c.thinkingLevel}</Menu.Label>
      {COMPOSER_THINKING_LEVELS.map((level) => {
        const selected = thinking === level;
        return <Menu.Item className="pwa-command-row pwa-command-choice" data-selected={selected || undefined} key={level} disabled={actionDisabled} leftSection={<Gauge size={16} />} rightSection={selected ? <Check className="pwa-command-check" size={16} aria-label={c.currentThinkingLevel} /> : null} onClick={() => onSetThinking(level)}>
          <span className="pwa-command-copy"><span>{level}</span></span>
        </Menu.Item>;
      })}
    </div>;
  }

  return <div ref={panelRef} className="pwa-command-menu-panel">
    <Menu.Item className="pwa-command-row" disabled={newSessionDisabled} leftSection={<FilePlus2 size={16} />} onClick={onNewSession}>
      <span className="pwa-command-copy">
        {presentation === "command" ? <><code>/new</code><small>{c.newSession}</small></> : <span>{c.newSession}</span>}
      </span>
    </Menu.Item>
    <Menu.Item className="pwa-command-row" disabled={newSessionDisabled} leftSection={<Minimize2 size={16} />} onClick={onCompactSession}>
      <span className="pwa-command-copy">
        {presentation === "command" ? <><code>/compact</code><small>{c.compactContext}</small></> : <span>{c.compactContext}</span>}
      </span>
    </Menu.Item>
    {showModelControls ? <><Menu.Item className="pwa-command-row" data-command-view="models" disabled={actionDisabled} leftSection={<Cpu size={16} />} rightSection={<ChevronRight className="pwa-command-chevron" size={16} />} closeMenuOnClick={false} onClick={() => changeView("root", onOpenModels)}>
      <span className="pwa-command-copy">
        {presentation === "command" ? <code>/model</code> : <span>{c.changeModel}</span>}
        <small>{currentModelLabel}</small>
      </span>
    </Menu.Item>
    <Menu.Item className="pwa-command-row" data-command-view="thinking" disabled={actionDisabled} leftSection={<Gauge size={16} />} rightSection={<ChevronRight className="pwa-command-chevron" size={16} />} closeMenuOnClick={false} onClick={() => changeView("root", onOpenThinking)}>
      <span className="pwa-command-copy">
        {presentation === "command" ? <code>/thinking</code> : <span>{c.thinkingLevel}</span>}
        <small>{presentation === "command" ? c.thinkingLevelValue(thinking) : thinking}</small>
      </span>
    </Menu.Item></> : null}
  </div>;
}

export function ComposerCommandMenu({ opened, initialView = "root", ...props }: ComposerCommandMenuProps) {
  const [view, setView] = useState<ComposerCommandMenuView>(opened ? initialView : "root");
  const [wasOpened, setWasOpened] = useState(opened);
  // 非零退出过渡可能被快速重开打断；不能靠 Dropdown 卸载才重置子视图：关闭即回到根视图，每次打开从起始视图开始。
  if (wasOpened !== opened) {
    setWasOpened(opened);
    setView(opened ? initialView : "root");
  }

  return <ComposerCommandMenuPanel
    {...props}
    view={view}
    onBack={() => setView("root")}
    onOpenModels={() => setView("models")}
    onOpenThinking={() => setView("thinking")}
  />;
}
