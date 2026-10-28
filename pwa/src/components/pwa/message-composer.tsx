import { createContext, memo, useCallback, useContext, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { ActionIcon, FileButton, Menu, Textarea, UnstyledButton } from "@mantine/core";
import { ArrowUp, Camera, ChevronDown, Files, LoaderCircle, Plus, Slash, Square } from "lucide-react";
import { AttachmentCards, type ComposerAttachmentItem } from "./attachment-cards";
import { ComposerCommandMenu, ComposerModelSettingsMenu, type ComposerCommandAction, type ModelListStatus } from "./composer-command-menu";
import { useMenuExitAction, usePwaMenuTransition } from "./use-pwa-motion";
import { useComposerAutosize } from "./use-composer-autosize";
import type { ThinkingLevel, WireModel } from "@/lib/pi-reach/types";
import type { OperationHint } from "@/lib/pwa/operation-feedback";
import { useI18n } from "@/lib/i18n";
import { useFloatingSafeMiddlewares } from "@/lib/ui/safe-area";
import { SMALL_SPINNER_SIZE, SMALL_SPINNER_STROKE } from "@/lib/ui/icon-metrics";
import { hasKeyboardOverlay, ignoreShortcutEvent, isPrimaryModifier, useEnterSends } from "@/lib/pwa/keyboard-shortcuts";
import { DESKTOP_LAYOUT_QUERY } from "@/lib/ui/viewport-queries";

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
  const menuTransition = usePwaMenuTransition();
  const floatingMiddlewares = useFloatingSafeMiddlewares();
  return <Menu
    middlewares={floatingMiddlewares}
    closeOnEscape
    closeOnClickOutside
    floatingStrategy="fixed"
    onChange={onChange}
    opened={opened}
    portalProps={{ target: ".pwa-root" }}
    position="top-start"
    returnFocus={returnFocus}
    transitionProps={menuTransition}
    onExitTransitionEnd={onExitTransitionEnd}
    withinPortal={withinPortal}
    zIndex="var(--pwa-z-workspace-float)"
  >
    <Menu.Target>
      <ActionIcon ref={triggerRef} className="pwa-composer-icon" type="button" disabled={disabled} aria-label={t.attachments.add} title={t.attachments.add}><Plus size={20} /></ActionIcon>
    </Menu.Target>
    <Menu.Dropdown inert={!opened} className="pwa-composer-menu-panel pwa-menu-motion" style={{ bottom: "auto" }}>
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
  /** 新建、停止与配置确认的进行中提示；与输入约束共用一行，优先级高于附件与断线提示。 */
  operationHint?: OperationHint | null;
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
  commandModelsStatus?: ModelListStatus;
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

type ComposerContentProps = Omit<MessageComposerProps, "queuedMessages">;
const QueuedMessagesContext = createContext<ReactNode>(null);

function ComposerQueuedMessages() {
  return useContext(QueuedMessagesContext);
}

/** 队列可随时间线更新，但不让它的新插槽引用反复渲染输入框和菜单。 */
export function MessageComposer({ enterSends, queuedMessages, ...props }: MessageComposerProps & { enterSends?: boolean }) {
  return <QueuedMessagesContext.Provider value={queuedMessages}>
    {enterSends === undefined
      ? <PersistedMessageComposer {...props} />
      : <MessageComposerContent {...props} enterSends={enterSends} />}
  </QueuedMessagesContext.Provider>;
}

const PersistedMessageComposer = memo(function PersistedMessageComposer(props: ComposerContentProps) {
  const [enterSends] = useEnterSends();
  return <MessageComposerContent {...props} enterSends={enterSends} />;
});

const MessageComposerContent = memo(function MessageComposerContent({
  attachments,
  canAttach,
  sendingAttachments,
  attachmentNotice,
  operationHint = null,
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
  commandModelsStatus,
  commandCurrentModel,
  commandCurrentModelFallback,
  commandThinking,
  commandPendingAction,
  onNewSession,
  onCompactSession,
  onSetModel,
  onSetThinking,
  onCommandsOpen,
  enterSends,
}: ComposerContentProps & { enterSends: boolean }) {
  const floatingMiddlewares = useFloatingSafeMiddlewares();
  const { t } = useI18n();
  const menuTransition = usePwaMenuTransition();
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
  const composingRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  // 模型标签是模型与思考级别的唯一入口，与会话命令菜单分别锚定。
  const modelAction = useMenuExitAction();
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const modelMenuOpenRef = useRef(false);
  const modelFocusIntentRef = useRef<"first" | "last" | null>(null);
  const modelFocusFrameRef = useRef<number | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelExitPending, setModelExitPending] = useState(false);

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
      // 「/」只提供会话命令，不请求模型列表；模型列表只在模型设置菜单打开时请求一次。
      return;
    }
    commandFocusIntentRef.current = null;
    scheduleFocusReturn(commandFocusFrameRef, commandFocusOriginRef.current === "textarea" ? textareaRef : commandTriggerRef, () => !commandMenuOpenRef.current);
  }, [commandAction, setImageMenuOpened]);

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

  useComposerAutosize(textareaRef, draft);

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
  const newSessionPending = commandPendingAction === "session_new";
  const modelPending = modelExitPending || commandPendingAction === "model_set" || commandPendingAction === "thinking_set";
  // 运行中有草稿时显示发送，消息进入 Extension 队列；草稿为空才把按钮让给停止。
  const showStop = isOnline && isWorking && !hasMessage;
  const addDisabled = !canAttach || sendingAttachments || newSessionPending;
  const notice = attachmentNotice || (!isOnline ? t.composer.sendAfterReconnect : null);
  // 操作状态是当前最具体、最短命的一行，压过附件与断线提示；它结束后约束提示自动恢复。
  const hint = operationHint ?? (notice ? { text: notice, tone: "neutral" as const, busy: false } : null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sendPendingRef.current || !isOnline || sendingAttachments || newSessionPending || !hasMessage || (attachments.length > 0 && !canAttach)) return;
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
    if (sendingAttachments) return;
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

  // 首帧时 Dropdown 可能尚未挂载；保存待聚焦意图，在过渡 onEnter 时消费。
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
    if (commandMenuOpenRef.current && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      focusCommandItem(event.key === "ArrowUp");
      return;
    }
    const nativeEvent = event.nativeEvent;
    if (event.key !== "Enter" || !window.matchMedia(DESKTOP_LAYOUT_QUERY).matches
      || composingRef.current || ignoreShortcutEvent(nativeEvent) || event.altKey || event.shiftKey
      || commandMenuOpenRef.current || imageMenuOpenRef.current || modelMenuOpenRef.current
      || hasKeyboardOverlay()) return;
    const plainEnter = !event.metaKey && !event.ctrlKey;
    if (!(plainEnter ? enterSends : isPrimaryModifier(nativeEvent))) return;
    if (!isOnline || sendingAttachments || !hasMessage || (attachments.length > 0 && !canAttach)) return;
    // 仍由表单统一校验并发发送和权限；空草稿已在上方返回，快捷键不会触发运行中的停止按钮。
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
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
    setModelExitPending(true);
    modelAction.queue(() => { callback(); setModelExitPending(false); });
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
      <ComposerQueuedMessages />
      {hint ? <p className="pwa-composer-hint" role="status" data-tone={hint.tone}>
        {hint.busy ? <LoaderCircle className="pwa-spin" size={SMALL_SPINNER_SIZE} strokeWidth={SMALL_SPINNER_STROKE} aria-hidden="true" /> : null}
        <span>{hint.text}</span>
      </p> : null}
      <AttachmentCards items={attachments} onRemove={onRemoveAttachment} onRetry={onRetryAttachment} collapsible />
      <div className="pwa-composer-card">
        <Textarea ref={textareaRef} className="pwa-textarea" classNames={{ root: "pwa-composer-textarea", input: "pwa-composer-input" }} resize="none" value={draft} onChange={handleDraftChange} onKeyDown={handleTextareaKeyDown} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onPaste={handlePaste} placeholder={t.composer.placeholder} readOnly={sendingAttachments || newSessionPending} rows={1} />
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
              <Menu width="var(--pwa-command-menu-width)" middlewares={floatingMiddlewares} opened={commandMenuOpen} onChange={(opened) => { if (opened) commandFocusOriginRef.current = "trigger"; setCommandMenuOpened(opened); }} trapFocus={false} withInitialFocusPlaceholder={false} menuItemTabIndex={0} returnFocus={false} closeOnItemClick={false} clickOutsideEvents={["mousedown", "touchstart"]} closeOnClickOutside closeOnEscape position="top-start" preventPositionChangeWhenVisible={false} offset={{ mainAxis: 8, crossAxis: -52 }} transitionProps={{ ...menuTransition, onEnter: consumeCommandFocusIntent }} onExitTransitionEnd={finishCommandExit} floatingStrategy="fixed" withinPortal portalProps={{ target: ".pwa-root" }} zIndex="var(--pwa-z-workspace-float)">
                <Menu.Target>
                  <ActionIcon ref={commandTriggerRef} className="pwa-composer-icon" type="button" onKeyDown={handleCommandTriggerKeyDown} disabled={!isOnline || newSessionPending} aria-label={t.commands.piCommands} title={t.commands.piCommands}><Slash size={20} /></ActionIcon>
                </Menu.Target>
                <Menu.Dropdown ref={commandDropdownRef} inert={!commandMenuOpen} className="pwa-command-menu-dropdown pwa-menu-motion" aria-label={t.commands.piCommands}>
                  <ComposerCommandMenu
                    isOnline={isOnline}
                    isWorking={isWorking}
                    pendingAction={commandPendingAction}
                    onNewSession={() => closeCommandThen(onNewSession)}
                    onCompactSession={() => closeCommandThen(onCompactSession)}
                  />
                </Menu.Dropdown>
              </Menu>
            </div>
          </div>
          <div className="pwa-composer-actions">
            <Menu width="var(--pwa-command-menu-width)" middlewares={floatingMiddlewares} opened={modelMenuOpen} onChange={setModelMenuOpened} trapFocus={false} withInitialFocusPlaceholder={false} menuItemTabIndex={0} returnFocus={false} closeOnItemClick={false} clickOutsideEvents={["mousedown", "touchstart"]} closeOnClickOutside closeOnEscape position="top-end" preventPositionChangeWhenVisible={false} offset={8} transitionProps={{ ...menuTransition, onEnter: consumeModelFocusIntent }} onExitTransitionEnd={finishModelExit} floatingStrategy="fixed" withinPortal portalProps={{ target: ".pwa-root" }} zIndex="var(--pwa-z-workspace-float)">
              <Menu.Target>
                <UnstyledButton ref={modelTriggerRef} className="pwa-composer-model" onKeyDown={handleModelTriggerKeyDown} disabled={!isOnline || newSessionPending} aria-busy={modelPending || undefined} aria-label={t.commands.modelChipLabel(modelName ?? t.commands.currentModelUnavailable, commandThinking)} title={t.commands.modelChipLabel(modelName ?? t.commands.currentModelUnavailable, commandThinking)}>
                  <span className="pwa-composer-model-name">{modelName ?? t.commands.modelSettings}</span>
                  <span className="pwa-composer-model-thinking" aria-hidden="true"> · {commandThinking}</span>
                  {modelPending ? <LoaderCircle className="pwa-spin pwa-operation-model-pending" size={16} aria-label={t.operationFeedback.modelPending} /> : <ChevronDown size={16} aria-hidden="true" />}
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown ref={modelDropdownRef} inert={!modelMenuOpen} className="pwa-command-menu-dropdown pwa-menu-motion" aria-label={t.commands.modelSettings}>
                <ComposerModelSettingsMenu
                  opened={modelMenuOpen}
                  isOnline={isOnline}
                  pendingAction={commandPendingAction}
                  models={commandModels}
                  modelsStatus={commandModelsStatus}
                  onRetryModels={onCommandsOpen}
                  currentModel={commandCurrentModel}
                  currentModelFallback={commandCurrentModelFallback}
                  thinking={commandThinking}
                  onSetModel={(model) => closeModelThen(() => onSetModel(model))}
                  onSetThinking={(level) => closeModelThen(() => onSetThinking(level))}
                />
              </Menu.Dropdown>
            </Menu>
            {showStop ? <ActionIcon className="pwa-composer-stop" variant="filled" type="button" onClick={onStop} disabled={stopping || newSessionPending} aria-label={stopping ? t.composer.stoppingTask : t.composer.stopTask} title={stopping ? t.composer.stoppingTask : t.composer.stopTask}>{stopping ? <LoaderCircle className="pwa-spin" size={20} /> : <Square size={16} fill="currentColor" />}</ActionIcon> : <ActionIcon className="pwa-composer-send" variant="filled" type="submit" disabled={!isOnline || sendingAttachments || newSessionPending || !hasMessage || (attachments.length > 0 && !canAttach)} aria-label={t.composer.send} title={t.composer.send}><ArrowUp size={20} /></ActionIcon>}
          </div>
        </div>
      </div>
    </form>
  );
});

type ReadOnlyComposerProps = {
  notice: string;
  /** 该 Pi 最后已知的模型；本地没有记录时不显示模型标签。 */
  modelName: string | null;
  thinking: ThinkingLevel;
};

/** 只读历史的输入区：与在线输入框同一结构和样式，所有控件禁用，提示区说明只读原因。 */
export function ReadOnlyComposer({ notice, modelName, thinking }: ReadOnlyComposerProps) {
  const { t } = useI18n();
  const modelLabel = modelName ? t.commands.modelChipLabel(modelName, thinking) : null;
  return (
    <div className="pwa-composer">
      <p className="pwa-composer-hint" role="note">{notice}</p>
      <div className="pwa-composer-card">
        <Textarea className="pwa-textarea" classNames={{ root: "pwa-composer-textarea", input: "pwa-composer-input" }} resize="none" value="" placeholder={t.composer.readOnlyPlaceholder} aria-label={t.composer.readOnlyPlaceholder} disabled rows={1} />
        <div className="pwa-composer-footer">
          <div className="pwa-composer-tools">
            <div className="pwa-composer-menu"><ActionIcon className="pwa-composer-icon" type="button" disabled aria-label={t.attachments.add} title={t.attachments.add}><Plus size={20} /></ActionIcon></div>
            <div className="pwa-composer-command"><ActionIcon className="pwa-composer-icon" type="button" disabled aria-label={t.commands.piCommands} title={t.commands.piCommands}><Slash size={20} /></ActionIcon></div>
          </div>
          <div className="pwa-composer-actions">
            {modelName && modelLabel ? <UnstyledButton className="pwa-composer-model" disabled aria-label={modelLabel} title={modelLabel}>
              <span className="pwa-composer-model-name">{modelName}</span>
              <span className="pwa-composer-model-thinking" aria-hidden="true"> · {thinking}</span>
              <ChevronDown size={16} aria-hidden="true" />
            </UnstyledButton> : null}
            <ActionIcon className="pwa-composer-send" variant="filled" type="button" disabled aria-label={t.composer.send} title={t.composer.send}><ArrowUp size={20} /></ActionIcon>
          </div>
        </div>
      </div>
    </div>
  );
}
