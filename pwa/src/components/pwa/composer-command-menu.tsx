import { useLayoutEffect, useRef, useState } from "react";
import { Menu } from "@mantine/core";
import { ArrowLeft, Check, ChevronRight, Cpu, FilePlus2, Gauge, Minimize2 } from "lucide-react";
import type { ThinkingLevel, WireModel } from "@/lib/pi-reach/types";
import { useI18n } from "@/lib/i18n";

export type ComposerCommandAction = "session_new" | "session_compact" | "model_set" | "thinking_set";

export const COMPOSER_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ThinkingLevel[];

/** 会话命令菜单：输入区的「/」只提供新会话与压缩。 */
export type ComposerCommandMenuPanelProps = {
  isOnline: boolean;
  isWorking: boolean;
  pendingAction: ComposerCommandAction | null;
  onNewSession: () => void;
  onCompactSession: () => void;
};

export type ComposerCommandMenuProps = ComposerCommandMenuPanelProps;

export function ComposerCommandMenuPanel({
  isOnline,
  isWorking,
  pendingAction,
  onNewSession,
  onCompactSession,
}: ComposerCommandMenuPanelProps) {
  const { t } = useI18n();
  const c = t.commands;
  const disabled = !isOnline || pendingAction !== null || isWorking;

  return <div className="pwa-command-menu-panel">
    <Menu.Item className="pwa-command-row" disabled={disabled} leftSection={<FilePlus2 size={16} />} onClick={onNewSession}>
      <span className="pwa-command-copy"><code>/new</code><small>{c.newSession}</small></span>
    </Menu.Item>
    <Menu.Item className="pwa-command-row" disabled={disabled} leftSection={<Minimize2 size={16} />} onClick={onCompactSession}>
      <span className="pwa-command-copy"><code>/compact</code><small>{c.compactContext}</small></span>
    </Menu.Item>
  </div>;
}

export function ComposerCommandMenu(props: ComposerCommandMenuProps) {
  return <ComposerCommandMenuPanel {...props} />;
}

/** 输入区模型标签的菜单：模型与思考级别的唯一入口。 */
export type ComposerModelSettingsView = "settings" | "models" | "thinking";

export type ComposerModelSettingsMenuPanelProps = {
  view: ComposerModelSettingsView;
  isOnline: boolean;
  pendingAction: ComposerCommandAction | null;
  models: WireModel[];
  currentModel: WireModel | null;
  currentModelFallback: string | null;
  thinking: ThinkingLevel;
  onSetModel: (model: WireModel) => void;
  onSetThinking: (level: ThinkingLevel) => void;
  onBack: () => void;
  onOpenModels: () => void;
  onOpenThinking: () => void;
};

export type ComposerModelSettingsMenuProps = Omit<ComposerModelSettingsMenuPanelProps, "view" | "onBack" | "onOpenModels" | "onOpenThinking"> & {
  opened: boolean;
};

function modelLabel(model: WireModel): string {
  return `${model.provider} / ${model.name}`;
}

function isCurrentModel(model: WireModel, currentModel: WireModel | null): boolean {
  return currentModel?.provider === model.provider && currentModel.id === model.id;
}

function useCommandViewFocus(view: ComposerModelSettingsView) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const focusTargetRef = useRef<ComposerModelSettingsView | null>(null);
  const changeView = (target: ComposerModelSettingsView, callback: () => void) => {
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

export function ComposerModelSettingsMenuPanel({
  view,
  isOnline,
  pendingAction,
  models,
  currentModel,
  currentModelFallback,
  thinking,
  onSetModel,
  onSetThinking,
  onBack,
  onOpenModels,
  onOpenThinking,
}: ComposerModelSettingsMenuPanelProps) {
  const { t } = useI18n();
  const c = t.commands;
  const { panelRef, changeView } = useCommandViewFocus(view);
  const actionDisabled = !isOnline || pendingAction !== null;
  const currentModelLabel = currentModel
    ? modelLabel(currentModel)
    : currentModelFallback || c.currentModelUnavailable;

  if (view === "models") {
    return <div ref={panelRef} className="pwa-command-menu-panel" role="group" aria-label={c.changeModel}>
      <Menu.Item className="pwa-command-back" data-command-view="settings" leftSection={<ArrowLeft size={16} />} closeMenuOnClick={false} onClick={() => changeView("models", onBack)}>{t.common.back}</Menu.Item>
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
      <Menu.Item className="pwa-command-back" data-command-view="settings" leftSection={<ArrowLeft size={16} />} closeMenuOnClick={false} onClick={() => changeView("thinking", onBack)}>{t.common.back}</Menu.Item>
      <Menu.Label className="pwa-command-menu-heading">{c.thinkingLevel}</Menu.Label>
      {COMPOSER_THINKING_LEVELS.map((level) => {
        const selected = thinking === level;
        return <Menu.Item className="pwa-command-row pwa-command-choice" data-selected={selected || undefined} key={level} disabled={actionDisabled} leftSection={<Gauge size={16} />} rightSection={selected ? <Check className="pwa-command-check" size={16} aria-label={c.currentThinkingLevel} /> : null} onClick={() => onSetThinking(level)}>
          <span className="pwa-command-copy"><span>{level}</span></span>
        </Menu.Item>;
      })}
    </div>;
  }

  return <div ref={panelRef} className="pwa-command-menu-panel" role="group" aria-label={c.modelSettings}>
    <Menu.Item className="pwa-command-row" data-command-view="models" disabled={actionDisabled} leftSection={<Cpu size={16} />} rightSection={<ChevronRight className="pwa-command-chevron" size={16} />} closeMenuOnClick={false} onClick={() => changeView("settings", onOpenModels)}>
      <span className="pwa-command-copy"><span>{c.changeModel}</span><small>{currentModelLabel}</small></span>
    </Menu.Item>
    <Menu.Item className="pwa-command-row" data-command-view="thinking" disabled={actionDisabled} leftSection={<Gauge size={16} />} rightSection={<ChevronRight className="pwa-command-chevron" size={16} />} closeMenuOnClick={false} onClick={() => changeView("settings", onOpenThinking)}>
      <span className="pwa-command-copy"><span>{c.thinkingLevel}</span><small>{c.thinkingLevelValue(thinking)}</small></span>
    </Menu.Item>
  </div>;
}

export function ComposerModelSettingsMenu({ opened, ...props }: ComposerModelSettingsMenuProps) {
  const [view, setView] = useState<ComposerModelSettingsView>("settings");
  const [wasOpened, setWasOpened] = useState(opened);
  // 关闭即回到设置根；每次打开都从根开始，快速重开也不会停留在子视图。
  if (wasOpened !== opened) {
    setWasOpened(opened);
    setView("settings");
  }

  return <ComposerModelSettingsMenuPanel
    {...props}
    view={view}
    onBack={() => setView("settings")}
    onOpenModels={() => setView("models")}
    onOpenThinking={() => setView("thinking")}
  />;
}
