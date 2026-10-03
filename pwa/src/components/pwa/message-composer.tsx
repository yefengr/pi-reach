import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { ActionIcon, FileButton, Menu, Textarea, UnstyledButton } from "@mantine/core";
import { ArrowUp, Camera, ChevronDown, Files, LoaderCircle, Plus, Slash, Square } from "lucide-react";
import { AttachmentCards, type ComposerAttachmentItem } from "./attachment-cards";
import { ComposerCommandMenu, type ComposerCommandAction } from "./composer-command-menu";
import { pwaFadeTransition, useMenuExitAction, usePwaMotionDuration } from "./use-pwa-motion";
import { useComposerAutosize } from "./use-composer-autosize";
import type { ThinkingLevel, WireModel } from "@/lib/pi-reach/types";
import { useI18n } from "@/lib/i18n";

type ComposerAttachmentMenuProps = {
  disabled: boolean;
  opened: boolean;
  onChange: (opened: boolean) => void;
  onChooseFiles: () => void;
  onUseCamera: () => void;
  returnFocus?: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
  withinPortal?: boolean;
  onExitTransitionEnd?: () => void;
};

export function ComposerAttachmentMenu({ disabled, opened, onChange, onChooseFiles, onUseCamera, returnFocus = true, triggerRef, withinPortal = true, onExitTransitionEnd }: ComposerAttachmentMenuProps) {
  const { t } = useI18n();
  const menuDuration = usePwaMotionDuration("--pwa-duration-fade", 120);
  return <Menu
    closeOnEscape
    closeOnClickOutside
    floatingStrategy="fixed"
    onChange={onChange}
    opened={opened}
    portalProps={{ target: ".pwa-root" }}
    position="top-start"
    returnFocus={returnFocus}
    transitionProps={{ transition: pwaFadeTransition, duration: menuDuration }}
    onExitTransitionEnd={onExitTransitionEnd}
    withinPortal={withinPortal}
    zIndex={21}
  >
    <Menu.Target>
      <ActionIcon ref={triggerRef} className="pwa-composer-icon" type="button" disabled={disabled} aria-label={t.attachments.add} title={t.attachments.add}><Plus size={20} /></ActionIcon>
    </Menu.Target>
    <Menu.Dropdown inert={!opened} className="pwa-composer-menu-panel" style={{ bottom: "auto" }}>
      <Menu.Item leftSection={<Files size={20} />} onClick={onChooseFiles} disabled={disabled}>{t.attachments.choose}</Menu.Item>
      <Menu.Item leftSection={<Camera size={20} />} onClick={onUseCamera} disabled={disabled}>{t.composer.useCamera}</Menu.Item>
    </Menu.Dropdown>
  </Menu>;
}

function hasValidPageFocus() {
  const activeElement = document.activeElement;
  return activeElement instanceof HTMLElement
    && activeElement !== document.body
    && activeElement !== document.documentElement
    && activeElement.isConnected
    // 正在关闭的 Dropdown 已被置为 inert，其内部残留焦点不应被当成有效页面焦点。
    && activeElement.closest("[inert]") === null;
}

function scheduleFocusReturn(
  frameRef: { current: number | null },
  originRef: { current: HTMLElement | null },
  isStillClosed: () => boolean,
) {
  if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  frameRef.current = requestAnimationFrame(() => {
    frameRef.current = null;
    // 未在退出过程中重开，且焦点已落到 body 或仍残留在关闭的菜单里时才回焦。
    if (isStillClosed() && !hasValidPageFocus()) originRef.current?.focus({ preventScroll: true });
  });
}

type MessageComposerProps = {
  attachments: readonly ComposerAttachmentItem[];
  canAttach: boolean;
  sendingAttachments: boolean;
  attachmentNotice?: string | null;
  isOnline: boolean;
  isWorking: boolean;
  stopping: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  onStop: () => void;
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onRetryAttachment: (id: string) => void;
  commandModels: WireModel[];
  commandCurrentModel: WireModel | null;
  commandCurrentModelFallback: string | null;
  commandThinking: ThinkingLevel;
  commandPendingAction: ComposerCommandAction | null;
  onNewSession: () => void;
  onCompactSession: () => void;
  onSetModel: (model: WireModel) => void;
  onSetThinking: (level: ThinkingLevel) => void;
  onCommandsOpen: () => void;
  queuedMessages?: ReactNode;
};

export function MessageComposer({
  attachments,
  canAttach,
  sendingAttachments,
  attachmentNotice,
  isOnline,
  isWorking,
  stopping,
  draft,
  onDraftChange,
  onSend,
  onStop,
  onAddFiles,
  onRemoveAttachment,
  onRetryAttachment,
  commandModels,
  commandCurrentModel,
  commandCurrentModelFallback,
  commandThinking,
  commandPendingAction,
  onNewSession,
  onCompactSession,
  onSetModel,
  onSetThinking,
  onCommandsOpen,
  queuedMessages,
}: MessageComposerProps) {
  const { t } = useI18n();
  const menuDuration = usePwaMotionDuration("--pwa-duration-fade", 120);
  const commandAction = useMenuExitAction();
  const resetRef = useRef<(() => void) | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageTriggerRef = useRef<HTMLButtonElement | null>(null);
  const commandTriggerRef = useRef<HTMLButtonElement | null>(null);
  const commandDropdownRef = useRef<HTMLDivElement | null>(null);
  const commandFocusIntentRef = useRef<"first" | "last" | null>(null);
  const imageMenuOpenRef = useRef(false);
  const commandMenuOpenRef = useRef(false);
  const commandFocusOriginRef = useRef<"trigger" | "textarea">("trigger");
  const imageFocusFrameRef = useRef<number | null>(null);
  const commandFocusFrameRef = useRef<number | null>(null);
  const sendPendingRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  // 输入区的模型标签：单独锚定的菜单，复用命令面板并直接进入模型列表。
  const modelAction = useMenuExitAction();
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const modelMenuOpenRef = useRef(false);
  const modelFocusIntentRef = useRef<"first" | "last" | null>(null);
  const modelFocusFrameRef = useRef<number | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  const setImageMenuOpened = useCallback((opened: boolean) => {
    const wasOpen = imageMenuOpenRef.current;
    imageMenuOpenRef.current = opened;
    setMenuOpen(opened);
    if (opened) {
      if (imageFocusFrameRef.current !== null) cancelAnimationFrame(imageFocusFrameRef.current);
      imageFocusFrameRef.current = null;
      return;
    }
    if (wasOpen) scheduleFocusReturn(imageFocusFrameRef, imageTriggerRef, () => !imageMenuOpenRef.current);
  }, []);

  const setCommandMenuOpened = useCallback((opened: boolean) => {
    if (opened && commandAction.hasPending()) return;
    const wasOpen = commandMenuOpenRef.current;
    if (wasOpen === opened) return;
    commandMenuOpenRef.current = opened;
    setCommandMenuOpen(opened);
    if (opened) {
      if (commandFocusFrameRef.current !== null) cancelAnimationFrame(commandFocusFrameRef.current);
      commandFocusFrameRef.current = null;
      setImageMenuOpened(false);
      modelMenuOpenRef.current = false;
      setModelMenuOpen(false);
      onCommandsOpen();
      return;
    }
    commandFocusIntentRef.current = null;
    scheduleFocusReturn(commandFocusFrameRef, commandFocusOriginRef.current === "textarea" ? textareaRef : commandTriggerRef, () => !commandMenuOpenRef.current);
  }, [commandAction, onCommandsOpen, setImageMenuOpened]);

  const setModelMenuOpened = useCallback((opened: boolean) => {
    if (opened && modelAction.hasPending()) return;
    const wasOpen = modelMenuOpenRef.current;
    if (wasOpen === opened) return;
    modelMenuOpenRef.current = opened;
    setModelMenuOpen(opened);
    if (opened) {
      if (modelFocusFrameRef.current !== null) cancelAnimationFrame(modelFocusFrameRef.current);
      modelFocusFrameRef.current = null;
      setCommandMenuOpened(false);
      setImageMenuOpened(false);
      onCommandsOpen();
      return;
    }
    modelFocusIntentRef.current = null;
    scheduleFocusReturn(modelFocusFrameRef, modelTriggerRef, () => !modelMenuOpenRef.current);
  }, [modelAction, onCommandsOpen, setCommandMenuOpened, setImageMenuOpened]);

  useComposerAutosize(textareaRef);

  useEffect(() => {
    if (!commandMenuOpen) return;
    const closeCommandMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && commandMenuOpenRef.current && !commandDropdownRef.current?.contains(event.target as Node)) setCommandMenuOpened(false);
    };
    document.addEventListener("keydown", closeCommandMenuOnEscape);
    return () => document.removeEventListener("keydown", closeCommandMenuOnEscape);
  }, [commandMenuOpen, setCommandMenuOpened]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const closeModelMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && modelMenuOpenRef.current && !modelDropdownRef.current?.contains(event.target as Node)) setModelMenuOpened(false);
    };
    document.addEventListener("keydown", closeModelMenuOnEscape);
    return () => document.removeEventListener("keydown", closeModelMenuOnEscape);
  }, [modelMenuOpen, setModelMenuOpened]);

  useEffect(() => () => {
    if (imageFocusFrameRef.current !== null) cancelAnimationFrame(imageFocusFrameRef.current);
    if (commandFocusFrameRef.current !== null) cancelAnimationFrame(commandFocusFrameRef.current);
    if (modelFocusFrameRef.current !== null) cancelAnimationFrame(modelFocusFrameRef.current);
  }, []);

  const hasMessage = Boolean(draft.trim() || attachments.length);
  const showStop = isOnline && isWorking;
  const addDisabled = !canAttach || sendingAttachments;
  const notice = attachmentNotice || (!isOnline ? t.composer.sendAfterReconnect : null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sendPendingRef.current || !isOnline || showStop || sendingAttachments || !hasMessage || (attachments.length > 0 && !canAttach)) return;
    sendPendingRef.current = true;
    try {
      await onSend();
    } finally {
      sendPendingRef.current = false;
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (!files.length || addDisabled) return;
    event.preventDefault();
    onAddFiles(files);
  };

  const useCamera = () => {
    setImageMenuOpened(false);
    if (!addDisabled) cameraInputRef.current?.click();
  };

  const handleDraftChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget;
    onDraftChange(textarea.value);
    const inputEvent = event.nativeEvent;
    // 只识别开头实际键入的 /；粘贴、正文中的 / 和程序恢复的草稿不触发菜单。
    if (commandMenuOpenRef.current || !isOnline || sendingAttachments || !(inputEvent instanceof InputEvent)
      || inputEvent.isComposing || inputEvent.inputType !== "insertText" || inputEvent.data !== "/"
      || textarea.selectionStart !== 1 || textarea.selectionEnd !== 1) return;
    commandFocusOriginRef.current = "textarea";
    setCommandMenuOpened(true);
  };

  // 菜单以 120ms 过渡入场，首帧时 Dropdown 可能尚未挂载；保存待聚焦意图，在过渡 onEnter 时消费。
  const consumeCommandFocusIntent = () => {
    const intent = commandFocusIntentRef.current;
    if (!intent || !commandMenuOpenRef.current || commandDropdownRef.current?.inert) return;
    const items = commandDropdownRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-item]:not(:disabled)");
    if (!items?.length) return;
    commandFocusIntentRef.current = null;
    items[intent === "last" ? items.length - 1 : 0].focus({ preventScroll: true });
  };

  const focusCommandItem = (last: boolean) => {
    commandFocusIntentRef.current = last ? "last" : "first";
    consumeCommandFocusIntent();
  };

  const handleTextareaKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!commandMenuOpenRef.current || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    focusCommandItem(event.key === "ArrowUp");
  };

  const handleCommandTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    commandFocusOriginRef.current = "trigger";
    setCommandMenuOpened(true);
    focusCommandItem(event.key === "ArrowUp");
  };

  const closeCommandThen = (callback: () => void) => {
    if (commandAction.hasPending()) return;
    commandAction.queue(callback);
    // 确认框以稳定按钮为起点；键入 / 的菜单动作则返回原输入框，保留草稿光标。
    const focusOrigin = commandFocusOriginRef.current === "textarea" ? textareaRef.current : commandTriggerRef.current;
    focusOrigin?.focus({ preventScroll: true });
    setCommandMenuOpened(false);
  };

  const consumeModelFocusIntent = () => {
    const intent = modelFocusIntentRef.current;
    if (!intent || !modelMenuOpenRef.current || modelDropdownRef.current?.inert) return;
    const items = modelDropdownRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-item]:not(:disabled)");
    if (!items?.length) return;
    modelFocusIntentRef.current = null;
    items[intent === "last" ? items.length - 1 : 0].focus({ preventScroll: true });
  };

  const handleModelTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setModelMenuOpened(true);
    modelFocusIntentRef.current = event.key === "ArrowUp" ? "last" : "first";
    consumeModelFocusIntent();
  };

  const closeModelThen = (callback: () => void) => {
    if (modelAction.hasPending()) return;
    modelAction.queue(callback);
    modelTriggerRef.current?.focus({ preventScroll: true });
    setModelMenuOpened(false);
  };

  const finishModelExit = () => {
    if (!modelMenuOpenRef.current && !hasValidPageFocus()) modelTriggerRef.current?.focus({ preventScroll: true });
    modelAction.finish();
  };

  const modelName = commandCurrentModel?.name ?? commandCurrentModelFallback;

  const finishCommandExit = () => {
    if (!commandMenuOpenRef.current && !hasValidPageFocus()) {
      const origin = commandFocusOriginRef.current === "textarea" ? textareaRef : commandTriggerRef;
      origin.current?.focus({ preventScroll: true });
    }
    commandAction.finish();
  };

  return (
    <form className="pwa-composer" onSubmit={handleSubmit}>
      <input ref={cameraInputRef} className="pwa-image-input" type="file" accept="image/*" capture="environment" disabled={addDisabled} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file && !addDisabled) onAddFiles([file]); event.currentTarget.value = ""; }} />
      {queuedMessages}
      {notice ? <p className="pwa-composer-hint" role="status">{notice}</p> : null}
      <AttachmentCards items={attachments} onRemove={onRemoveAttachment} onRetry={onRetryAttachment} collapsible />
      <div className="pwa-composer-card">
        <Textarea ref={textareaRef} className="pwa-textarea" classNames={{ root: "pwa-composer-textarea", input: "pwa-composer-input" }} resize="none" value={draft} onChange={handleDraftChange} onKeyDown={handleTextareaKeyDown} onPaste={handlePaste} placeholder={t.composer.placeholder} disabled={sendingAttachments} rows={1} />
        <div className="pwa-composer-footer">
          <div className="pwa-composer-tools">
            <div className="pwa-composer-menu">
              <FileButton
                multiple
                disabled={addDisabled}
                inputProps={{ className: "pwa-image-input" }}
                resetRef={resetRef}
                onChange={(files) => {
                  if (!files.length || addDisabled) return;
                  onAddFiles(files);
                  resetRef.current?.();
                }}
              >
                {({ onClick }) => (
                  <ComposerAttachmentMenu
                    disabled={addDisabled}
                    opened={menuOpen}
                    onChange={(opened) => {
                      if (opened) {
                        setCommandMenuOpened(false);
                        setModelMenuOpened(false);
                      }
                      setImageMenuOpened(opened);
                    }}
                    onChooseFiles={() => {
                      setImageMenuOpened(false);
                      if (!addDisabled) onClick();
                    }}
                    onUseCamera={useCamera}
                    returnFocus={false}
                    triggerRef={imageTriggerRef}
                    onExitTransitionEnd={() => {
                      if (!imageMenuOpenRef.current && !hasValidPageFocus()) imageTriggerRef.current?.focus({ preventScroll: true });
                    }}
                  />
                )}
              </FileButton>
            </div>
            <div className="pwa-composer-command">
              <Menu width="var(--pwa-command-menu-width)" opened={commandMenuOpen} onChange={(opened) => { if (opened) commandFocusOriginRef.current = "trigger"; setCommandMenuOpened(opened); }} trapFocus={false} withInitialFocusPlaceholder={false} menuItemTabIndex={0} returnFocus={false} closeOnItemClick={false} clickOutsideEvents={["mousedown", "touchstart"]} closeOnClickOutside closeOnEscape position="top-start" offset={{ mainAxis: 8, crossAxis: -52 }} transitionProps={{ transition: pwaFadeTransition, duration: menuDuration, onEnter: consumeCommandFocusIntent }} onExitTransitionEnd={finishCommandExit} floatingStrategy="fixed" withinPortal portalProps={{ target: ".pwa-root" }} zIndex={8}>
                <Menu.Target>
                  <ActionIcon ref={commandTriggerRef} className="pwa-composer-icon" type="button" onKeyDown={handleCommandTriggerKeyDown} disabled={!isOnline} aria-label={t.commands.piCommands} title={t.commands.piCommands}><Slash size={20} /></ActionIcon>
                </Menu.Target>
                <Menu.Dropdown ref={commandDropdownRef} inert={!commandMenuOpen} className="pwa-command-menu-dropdown" aria-label={t.commands.piCommands}>
                  <ComposerCommandMenu
                    opened={commandMenuOpen}
                    isOnline={isOnline}
                    isWorking={isWorking}
                    pendingAction={commandPendingAction}
                    models={commandModels}
                    currentModel={commandCurrentModel}
                    currentModelFallback={commandCurrentModelFallback}
                    thinking={commandThinking}
                    onNewSession={() => closeCommandThen(onNewSession)}
                    onCompactSession={() => closeCommandThen(onCompactSession)}
                    onSetModel={(model) => closeCommandThen(() => onSetModel(model))}
                    onSetThinking={(level) => closeCommandThen(() => onSetThinking(level))}
                  />
                </Menu.Dropdown>
              </Menu>
            </div>
          </div>
          <div className="pwa-composer-actions">
            {modelName ? <Menu width="var(--pwa-command-menu-width)" opened={modelMenuOpen} onChange={setModelMenuOpened} trapFocus={false} withInitialFocusPlaceholder={false} menuItemTabIndex={0} returnFocus={false} closeOnItemClick={false} clickOutsideEvents={["mousedown", "touchstart"]} closeOnClickOutside closeOnEscape position="top-end" offset={8} transitionProps={{ transition: pwaFadeTransition, duration: menuDuration, onEnter: consumeModelFocusIntent }} onExitTransitionEnd={finishModelExit} floatingStrategy="fixed" withinPortal portalProps={{ target: ".pwa-root" }} zIndex={8}>
              <Menu.Target>
                <UnstyledButton ref={modelTriggerRef} className="pwa-composer-model" onKeyDown={handleModelTriggerKeyDown} disabled={!isOnline} aria-label={t.commands.modelChipLabel(modelName, commandThinking)} title={t.commands.modelChipLabel(modelName, commandThinking)}>
                  <span className="pwa-composer-model-name">{modelName}</span>
                  <span className="pwa-composer-model-thinking" aria-hidden="true"> · {commandThinking}</span>
                  <ChevronDown size={16} aria-hidden="true" />
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown ref={modelDropdownRef} inert={!modelMenuOpen} className="pwa-command-menu-dropdown" aria-label={t.commands.changeModel}>
                <ComposerCommandMenu
                  opened={modelMenuOpen}
                  initialView="models"
                  isOnline={isOnline}
                  isWorking={isWorking}
                  pendingAction={commandPendingAction}
                  models={commandModels}
                  currentModel={commandCurrentModel}
                  currentModelFallback={commandCurrentModelFallback}
                  thinking={commandThinking}
                  onNewSession={() => closeModelThen(onNewSession)}
                  onCompactSession={() => closeModelThen(onCompactSession)}
                  onSetModel={(model) => closeModelThen(() => onSetModel(model))}
                  onSetThinking={(level) => closeModelThen(() => onSetThinking(level))}
                />
              </Menu.Dropdown>
            </Menu> : null}
            {showStop ? <ActionIcon className="pwa-composer-stop" variant="filled" color="piReach" type="button" onClick={onStop} disabled={stopping} aria-label={stopping ? t.composer.stoppingTask : t.composer.stopTask} title={stopping ? t.composer.stoppingTask : t.composer.stopTask}>{stopping ? <LoaderCircle className="pwa-spin" size={20} /> : <Square size={16} fill="currentColor" />}</ActionIcon> : <ActionIcon className="pwa-composer-send" variant="filled" color="piReach" type="submit" disabled={!isOnline || sendingAttachments || !hasMessage || (attachments.length > 0 && !canAttach)} aria-label={t.composer.send} title={t.composer.send}><ArrowUp size={20} /></ActionIcon>}
          </div>
        </div>
      </div>
    </form>
  );
}
