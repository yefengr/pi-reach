import { useState } from "react";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import type { ThinkingLevel, WireModel } from "@/lib/pi-reach/types";
import { MessageComposer } from "./message-composer";
import type { ComposerAttachmentItem } from "./attachment-cards";

const model: WireModel = {
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  provider: "anthropic",
  reasoning: true,
  context_window: 200_000,
  vision: true,
};

type ComposerHarnessProps = {
  initialDraft?: string;
  initialWorking?: boolean;
  attachmentNotice?: string;
  commandModels?: WireModel[];
  onCommandsOpen?: () => void;
  onNewSession?: () => void;
  onSend?: () => void | Promise<void>;
  onStop?: () => void;
  onAddFiles?: (files: File[]) => void;
  onSetModel?: (nextModel: WireModel) => void;
  onSetThinking?: (level: ThinkingLevel) => void;
};

function attachmentFrom(source: File): ComposerAttachmentItem {
  return { id: source.name, fileName: source.name, byteLength: source.size, status: "draft" };
}

function ComposerHarness({
  initialDraft = "",
  initialWorking = false,
  attachmentNotice,
  commandModels = [model],
  onCommandsOpen = () => {},
  onNewSession = () => {},
  onSend = () => {},
  onStop = () => {},
  onAddFiles = () => {},
  onSetModel = () => {},
  onSetThinking = () => {},
}: ComposerHarnessProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [attachments, setAttachments] = useState<ComposerAttachmentItem[]>([]);
  const [isOnline, setIsOnline] = useState(true);
  const [isWorking, setIsWorking] = useState(initialWorking);
  const [stopping, setStopping] = useState(false);
  const [sendingImage, setSendingImage] = useState(false);
  const [pendingAction, setPendingAction] = useState<"model_set" | null>(null);

  const addFiles = (files: File[]) => {
    onAddFiles(files);
    setAttachments(current => [...current, ...files.map(attachmentFrom)]);
  };

  return (
    <>
      <button type="button">Outside composer</button>
      <button type="button" data-testid="composer-set-draft" hidden onClick={() => setDraft("Continue this task")} />
      <button type="button" data-testid="composer-toggle-working" hidden onClick={() => setIsWorking((current) => !current)} />
      <button type="button" data-testid="composer-set-stopping" hidden onClick={() => setStopping(true)} />
      <button type="button" data-testid="composer-set-attachment" hidden onClick={() => setAttachments([attachmentFrom(new File(["image"], "Queued image", { type: "image/png" }))])} />
      <button type="button" data-testid="composer-set-sending-image" hidden onClick={() => setSendingImage(true)} />
      <button type="button" data-testid="composer-go-offline" hidden onClick={() => setIsOnline(false)} />
      <button type="button" data-testid="composer-set-command-pending" hidden onClick={() => setPendingAction("model_set")} />
      <MessageComposer
        attachments={attachments}
        canAttach={isOnline}
        sendingAttachments={sendingImage}
        attachmentNotice={attachmentNotice}
        isOnline={isOnline}
        isWorking={isWorking}
        stopping={stopping}
        draft={draft}
        onDraftChange={setDraft}
        onSend={onSend}
        onStop={onStop}
        onAddFiles={addFiles}
        onRemoveAttachment={id => setAttachments(current => current.filter(item => item.id !== id))}
        onRetryAttachment={() => {}}
        commandModels={commandModels}
        commandCurrentModel={model}
        commandCurrentModelFallback={null}
        commandThinking="medium"
        commandPendingAction={pendingAction}
        onNewSession={onNewSession}
        onCompactSession={() => {}}
        onSetModel={onSetModel}
        onSetThinking={onSetThinking}
        onCommandsOpen={onCommandsOpen}
      />
    </>
  );
}

test("keeps the image remove action at a 44px touch target", async () => {
  const screen = await renderPwa(<ComposerHarness />);
  screen.getByTestId("composer-set-attachment").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const remove = screen.getByRole("button", { name: "Remove Queued image" });
  await expect.element(remove).toBeVisible();
  const rect = remove.element().getBoundingClientRect();

  expect(rect.width).toBeGreaterThanOrEqual(44);
  expect(rect.height).toBeGreaterThanOrEqual(44);
});

test.each([[1280, 900], [390, 844]])("keeps a single Composer surface, frameless tools, and an accent Send target at %ix%i", async (width, height) => {
  await page.viewport(width, height);
  const screen = await renderPwa(<ComposerHarness />);
  try {
    const card = document.querySelector<HTMLElement>(".pwa-composer-card")!;
    const input = screen.getByRole("textbox").element() as HTMLTextAreaElement;
    const send = screen.getByRole("button", { name: "Send message" }).element() as HTMLButtonElement;
    const image = screen.getByRole("button", { name: "Add attachments" }).element();
    const commands = screen.getByRole("button", { name: "Pi commands" }).element();
    const cardStyle = getComputedStyle(card);
    const inputStyle = getComputedStyle(input);
    const paletteProbe = document.createElement("span");
    paletteProbe.style.cssText = "color: var(--pwa-accent); background: var(--pwa-surface)";
    card.append(paletteProbe);
    const accent = getComputedStyle(paletteProbe).color;
    const surface = getComputedStyle(paletteProbe).backgroundColor;
    paletteProbe.remove();
    expect(cardStyle.backgroundColor).toBe(surface);
    expect(cardStyle.borderTopWidth).toBe("1px");
    expect(cardStyle.paddingTop).toBe("10px");
    expect(cardStyle.paddingLeft).toBe("12px");
    expect(cardStyle.borderRadius).toBe("12px");
    expect(inputStyle.borderTopWidth).toBe("0px");
    expect(inputStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(inputStyle.paddingLeft).toBe("0px");
    for (const tool of [image, commands]) {
      expect(tool.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      expect(tool.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      expect(getComputedStyle(tool).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(tool, "::before").borderTopColor).toBe("rgba(0, 0, 0, 0)");
    }
    expect(send.querySelector("svg")?.classList.contains("lucide-arrow-up")).toBe(true);
    expect(send.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    expect(send.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(getComputedStyle(send, "::before").width).toBe("36px");
    expect(send.disabled).toBe(true);
    expect(getComputedStyle(send, "::before").backgroundColor).toBe(accent);
    expect(Number(getComputedStyle(send).opacity)).toBeLessThan(1);
    input.focus();
    await expect.element(screen.getByRole("textbox")).toHaveFocus();
    await expect.poll(() => getComputedStyle(card).borderColor).toBe(accent);
    await page.screenshot({ path: `../../../.vitest/screenshots/composer-${width}x${height}.png` });
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test.each([320, 390, 1440])("keeps a single attachment notice outside the cards and input surface at %ipx", async width => {
  await page.viewport(width, 900);
  const screen = await renderPwa(<ComposerHarness attachmentNotice="Uploads paused" />);
  screen.getByTestId("composer-set-attachment").element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  screen.getByTestId("composer-go-offline").element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await expect.element(screen.getByText("Uploads paused")).toBeVisible();
  const notice = document.querySelector<HTMLElement>(".pwa-composer-hint")!;
  const cards = document.querySelector<HTMLElement>(".pwa-attachment-cards")!;
  const surface = document.querySelector<HTMLElement>(".pwa-composer-card")!;
  expect(notice.parentElement).toBe(surface.parentElement);
  expect(surface.contains(cards)).toBe(false);
  expect(document.querySelectorAll(".pwa-composer-hint")).toHaveLength(1);
  expect(Math.round(notice.getBoundingClientRect().bottom)).toBeLessThanOrEqual(Math.round(cards.getBoundingClientRect().top));
  expect(Math.round(cards.getBoundingClientRect().bottom)).toBeLessThanOrEqual(Math.round(surface.getBoundingClientRect().top));
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  await screen.unmount();
  await page.viewport(1280, 900);
});

test("shows the Stop action with the same accent circle as Send", async () => {
  const screen = await renderPwa(<ComposerHarness initialWorking />);
  const stop = screen.getByRole("button", { name: "Stop current task" }).element();
  const rect = stop.getBoundingClientRect();

  // 与发送按钮同形同色：强调色圆（浅色 #446396、深色 #98B8E6）加 on-accent 图标，点击区 44px，不用错误色。
  expect(["rgb(68, 99, 150)", "rgb(152, 184, 230)"]).toContain(window.getComputedStyle(stop, "::before").backgroundColor);
  expect(["rgb(255, 255, 255)", "rgb(23, 38, 56)"]).toContain(window.getComputedStyle(stop).color);
  expect(rect.width).toBeGreaterThanOrEqual(44);
  expect(rect.height).toBeGreaterThanOrEqual(44);
  expect(stop.textContent).toBe("");
  await screen.unmount();
});

function getImageInputs(): [HTMLInputElement, HTMLInputElement] {
  const inputs = [...document.querySelectorAll<HTMLInputElement>("input.pwa-image-input")];
  expect(inputs).toHaveLength(2);
  const imageInput = inputs.find((input) => !input.hasAttribute("capture"));
  const cameraInput = inputs.find((input) => input.getAttribute("capture") === "environment");
  expect(imageInput).toBeDefined();
  expect(cameraInput).toBeDefined();
  return [imageInput!, cameraInput!];
}

function closePopoverFromOutside() {
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function settleOverlayFocus() {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
}

test("opens commands only when / is typed at the start; preserves the draft, caret and menu focus", async () => {
  let opens = 0;
  const screen = await renderPwa(<ComposerHarness onCommandsOpen={() => { opens += 1; }} />);
  const textbox = screen.getByRole("textbox");
  const input = textbox.element() as HTMLTextAreaElement;
  input.focus();
  await userEvent.keyboard("notes/inside");
  expect(input.value).toBe("notes/inside");
  expect(opens).toBe(0);
  await expect.element(screen.getByRole("menu", { name: "Pi commands" })).not.toBeInTheDocument();

  input.setSelectionRange(0, 0);
  await userEvent.keyboard("/");
  expect(input.value).toBe("/notes/inside");
  expect(input.selectionStart).toBe(1);
  expect(input.selectionEnd).toBe(1);
  expect(opens).toBe(1);
  await expect.element(screen.getByRole("menu", { name: "Pi commands" })).toBeVisible();
  await expect.element(textbox).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(screen.getByRole("menuitem", { name: /\/new/ })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("menu", { name: "Pi commands" })).not.toBeInTheDocument();
  await expect.element(textbox).toHaveFocus();
  expect(input.value).toBe("/notes/inside");
  expect(input.selectionStart).toBe(1);
  expect(input.selectionEnd).toBe(1);

  input.setSelectionRange(input.value.length, input.value.length);
  await userEvent.keyboard("/");
  expect(input.value).toBe("/notes/inside/");
  expect(opens).toBe(1);
});

test("keeps slash menu typing, button entry, menu actions and image menu focus isolated", async () => {
  let opens = 0;
  let thinking: ThinkingLevel | null = null;
  const screen = await renderPwa(<ComposerHarness onCommandsOpen={() => { opens += 1; }} onSetThinking={(value) => { thinking = value; }} />);
  const textbox = screen.getByRole("textbox");
  const input = textbox.element() as HTMLTextAreaElement;
  input.focus();
  await userEvent.keyboard("/");
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(screen.getByRole("menuitem", { name: /\/thinking/ })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("menuitem", { name: "Back", exact: true })).toHaveFocus();
  await screen.getByRole("menuitem", { name: "high", exact: true }).click();
  await expect.poll(() => thinking).toBe("high");
  await expect.element(textbox).toHaveFocus();
  expect(input.value).toBe("/");
  expect(input.selectionStart).toBe(1);
  expect(opens).toBe(1);

  const trigger = screen.getByRole("button", { name: "Pi commands" });
  trigger.element().focus();
  await trigger.click();
  await expect.element(screen.getByRole("menu", { name: "Pi commands" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
  const image = screen.getByRole("button", { name: "Add attachments" });
  image.element().focus();
  await image.click();
  await expect.element(screen.getByRole("menuitem", { name: "Choose files" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(image).toHaveFocus();
});

test("does not open commands for pasted slash or when offline", async () => {
  let opens = 0;
  const screen = await renderPwa(<ComposerHarness onCommandsOpen={() => { opens += 1; }} />);
  const textbox = screen.getByRole("textbox");
  const input = textbox.element() as HTMLTextAreaElement;
  input.focus();
  // Vitest Browser 的 userEvent.paste 无剪贴板写权限时只发 paste 事件；模拟浏览器粘贴的 insertFromPaste 输入。
  input.setRangeText("/pasted");
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: "/pasted" }));
  await expect.element(textbox).toHaveValue("/pasted");
  expect(opens).toBe(0);
  await expect.element(screen.getByRole("menu", { name: "Pi commands" })).not.toBeInTheDocument();
  screen.getByTestId("composer-go-offline").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  input.setSelectionRange(0, 0);
  await userEvent.keyboard("/");
  expect(input.value).toBe("//pasted");
  expect(opens).toBe(0);
});

test("portals mutually exclusive image and Pi command menus, then returns focus after closing", async () => {
  const screen = await renderPwa(<ComposerHarness />);
  const imageTrigger = screen.getByRole("button", { name: "Add attachments" });
  const commandTrigger = screen.getByRole("button", { name: "Pi commands" });

  imageTrigger.element().focus();
  await expect.element(imageTrigger).toHaveFocus();
  await imageTrigger.click();
  const chooseImage = screen.getByRole("menuitem", { name: "Choose files" });
  await expect.element(chooseImage).toBeVisible();
  expect(chooseImage.element().closest(".pwa-root")).not.toBeNull();
  chooseImage.element().focus();
  await expect.element(chooseImage).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(chooseImage).not.toBeInTheDocument();
  await expect.element(imageTrigger).toHaveFocus();

  await imageTrigger.click();
  await expect.element(screen.getByRole("menuitem", { name: "Choose files" })).toBeVisible();
  commandTrigger.element().focus();
  await commandTrigger.click();
  await expect.element(screen.getByRole("menuitem", { name: "Choose files" })).not.toBeInTheDocument();
  const commandsMenu = screen.getByRole("menu", { name: "Pi commands" });
  await expect.element(commandsMenu).toBeVisible();
  expect(commandsMenu.element().closest(".pwa-root")).not.toBeNull();
  await settleOverlayFocus();
  await expect.element(commandTrigger).toHaveFocus();
  const modelCommand = screen.getByRole("menuitem", { name: /\/model/ });
  modelCommand.element().focus();
  await expect.element(modelCommand).toHaveFocus();
  closePopoverFromOutside();
  await expect.element(commandsMenu).not.toBeInTheDocument();
  await expect.element(commandTrigger).toHaveFocus();
});

test("keeps both menu switch directions stable and does not steal valid outside focus", async () => {
  const screen = await renderPwa(<ComposerHarness />);
  const image = screen.getByRole("button", { name: "Add attachments" });
  const commands = screen.getByRole("button", { name: "Pi commands" });
  for (let cycle = 0; cycle < 2; cycle += 1) {
    commands.element().focus();
    await commands.click();
    await screen.getByRole("menuitem", { name: /\/model/ }).click();
    image.element().focus();
    await image.click();
    await settleOverlayFocus();
    await expect.element(screen.getByRole("menu", { name: "Pi commands" })).not.toBeInTheDocument();
    const chooseImage = screen.getByRole("menuitem", { name: "Choose files" });
    await expect.element(chooseImage).toBeVisible();
    expect(chooseImage.element().closest('[role="menu"]')?.contains(document.activeElement)).toBe(true);
    commands.element().focus();
    await commands.click();
    await settleOverlayFocus();
    await expect.element(commands).toHaveFocus();
    await expect.element(chooseImage).not.toBeInTheDocument();
    const outside = screen.getByRole("button", { name: "Outside composer" });
    await outside.click();
    await settleOverlayFocus();
    await expect.element(outside).toHaveFocus();
    await expect.element(screen.getByRole("menu", { name: "Pi commands" })).not.toBeInTheDocument();
  }
});

test("navigates command keys and subview Back without closing or requesting models again", async () => {
  let opens = 0;
  const screen = await renderPwa(<ComposerHarness initialWorking onCommandsOpen={() => { opens += 1; }} />);
  const trigger = screen.getByRole("button", { name: "Pi commands" });
  trigger.element().focus();
  await userEvent.keyboard("{ArrowDown}");
  const models = screen.getByRole("menuitem", { name: /\/model/ });
  const thinking = screen.getByRole("menuitem", { name: /\/thinking/ });
  await expect.element(models).toHaveFocus();
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(thinking).toHaveFocus();
  await userEvent.keyboard("{Home}");
  await expect.element(models).toHaveFocus();
  await userEvent.keyboard("{End}");
  await expect.element(thinking).toHaveFocus();
  for (const item of [thinking, models]) {
    item.element().focus();
    await userEvent.keyboard("{Enter}");
    const back = screen.getByRole("menuitem", { name: "Back", exact: true });
    await expect.element(back).toHaveFocus();
    await userEvent.keyboard("{End}");
    await expect.element(back).not.toHaveFocus();
    await userEvent.keyboard("{Home}{Enter}");
    await expect.element(item).toHaveFocus();
  }
  expect(opens).toBe(1);
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(thinking).toHaveFocus();
  expect(opens).toBe(2);
});

test("uses 16px action text in composer menus and keeps the current model and thinking level marked", async () => {
  const other: WireModel = { ...model, id: "other-model", name: "Other Model" };
  const screen = await renderPwa(<ComposerHarness commandModels={[model, other]} />);
  const probe = document.createElement("span");
  // 当前项用中性 selected 底与 ink 文字，不用主色。
  probe.style.color = "var(--pwa-ink)";
  probe.style.backgroundColor = "var(--pwa-selected)";
  document.querySelector(".pwa-root")!.append(probe);
  const ink = getComputedStyle(probe).color;
  const selectedBackground = getComputedStyle(probe).backgroundColor;

  await screen.getByRole("button", { name: "Add attachments" }).click();
  const choose = screen.getByRole("menuitem", { name: "Choose files" });
  await expect.element(choose).toBeVisible();
  expect(getComputedStyle(choose.element()).fontSize).toBe("16px");
  await userEvent.keyboard("{Escape}");

  await screen.getByRole("button", { name: "Pi commands" }).click();
  const modelEntry = screen.getByRole("menuitem", { name: /\/model/ });
  await expect.element(modelEntry).toBeVisible();
  expect(getComputedStyle(modelEntry.element().querySelector("code")!).fontSize).toBe("16px");
  expect(getComputedStyle(modelEntry.element().querySelector("small")!).fontSize).toBe("13px");

  for (const [entry, current, alternative] of [[/\/model/, /Claude Sonnet 4/, /Other Model/], [/\/thinking/, /^medium/, /^high/]] as const) {
    await screen.getByRole("menuitem", { name: entry }).click();
    const selected = screen.getByRole("menuitem", { name: current }).element() as HTMLElement;
    const unselected = screen.getByRole("menuitem", { name: alternative }).element() as HTMLElement;
    await expect.poll(() => getComputedStyle(selected).backgroundColor).toBe(selectedBackground);
    expect(getComputedStyle(selected.querySelector(".pwa-command-copy > span")!).color).toBe(ink);
    expect(getComputedStyle(selected.querySelector(".pwa-command-copy > span")!).fontSize).toBe("16px");
    expect(getComputedStyle(unselected).backgroundColor).not.toBe(selectedBackground);
    await userEvent.hover(unselected);
    unselected.focus();
    await expect.poll(() => getComputedStyle(selected).backgroundColor).toBe(selectedBackground);
    expect(getComputedStyle(unselected).backgroundColor).not.toBe(selectedBackground);
    await screen.getByRole("menuitem", { name: "Back", exact: true }).click();
  }
  probe.remove();
});

test.each([[1280, 900], [390, 844], [390, 500], [756, 413]])("keeps the Composer model menu usable at %ix%i", async (width, height) => {
  await page.viewport(width, height);
  const models = Array.from({ length: 24 }, (_, index) => ({ ...model, id: `composer-${index}`, name: `Model ${index} ${"Long name ".repeat(15)}` }));
  const screen = await renderPwa(<div style={{ position: "fixed", bottom: "env(safe-area-inset-bottom, 0px)", left: 0, right: 0 }}><ComposerHarness commandModels={models} /></div>);
  try {
    const trigger = screen.getByRole("button", { name: "Pi commands" });
    trigger.element().focus();
    await trigger.click();
    await screen.getByRole("menuitem", { name: /\/model/ }).click();
    const menu = screen.getByRole("menu", { name: "Pi commands" });
    await expect.poll(() => menu.element().getBoundingClientRect().top >= 0).toBe(true);
    const dropdown = menu.element() as HTMLElement;
    const box = dropdown.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(width);
    expect(box.bottom).toBeLessThanOrEqual(height);
    expect(dropdown.scrollWidth).toBeLessThanOrEqual(dropdown.clientWidth);
    expect(dropdown.scrollHeight).toBeGreaterThan(dropdown.clientHeight);
    expect(getComputedStyle(dropdown).overflowY).toBe("auto");
    expect(getComputedStyle(dropdown).zIndex).toBe("8");
    for (const item of dropdown.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
      expect(item.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    dropdown.scrollTop = dropdown.scrollHeight;
    const last = dropdown.querySelector<HTMLElement>('[role="menuitem"]:last-child')!;
    const lastBox = last.getBoundingClientRect();
    expect(lastBox.bottom).toBeLessThanOrEqual(box.bottom);
    expect(last.contains(document.elementFromPoint(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2))).toBe(true);
    await page.screenshot({ path: `../../../.vitest/screenshots/menu-composer-${width}x${height}.png` });
    await userEvent.keyboard("{Escape}");
    await settleOverlayFocus();
    await expect.element(trigger).toHaveFocus();
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("passes all selected, pasted and camera files without converting their originals", async () => {
  const attachments: File[][] = [];
  const screen = await renderPwa(<ComposerHarness onAddFiles={files => attachments.push(files)} />);
  const [imageInput, cameraInput] = getImageInputs();
  const imageTrigger = screen.getByRole("button", { name: "Add attachments" });

  expect(imageInput.accept).toBe("");
  expect(imageInput.multiple).toBe(true);
  expect(cameraInput.accept).toBe("image/*");
  expect(cameraInput.getAttribute("capture")).toBe("environment");

  let imageClicks = 0;
  let cameraClicks = 0;
  imageInput.addEventListener("click", () => { imageClicks += 1; });
  cameraInput.addEventListener("click", () => { cameraClicks += 1; });

  await imageTrigger.click();
  await screen.getByRole("menuitem", { name: "Choose files" }).click();
  expect(imageClicks).toBe(1);
  expect(cameraClicks).toBe(0);

  await imageTrigger.click();
  await screen.getByRole("menuitem", { name: "Use camera" }).click();
  expect(imageClicks).toBe(1);
  expect(cameraClicks).toBe(1);

  const textarea = screen.getByRole("textbox").element() as HTMLTextAreaElement;
  const imageFile = new File(["image"], "clipboard.webp", { type: "image/webp" });
  const imageClipboard = new DataTransfer();
  imageClipboard.items.add(imageFile);
  const imagePaste = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: imageClipboard,
  });
  textarea.dispatchEvent(imagePaste);
  expect(imagePaste.defaultPrevented).toBe(true);
  expect(attachments).toEqual([[imageFile]]);
  expect(attachments[0][0]).toBe(imageFile);

  const textFile = new File(["plain text"], "notes.txt", { type: "text/plain" });
  const textClipboard = new DataTransfer();
  textClipboard.items.add(textFile);
  const textPaste = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: textClipboard,
  });
  textarea.dispatchEvent(textPaste);
  expect(textPaste.defaultPrevented).toBe(true);
  expect(attachments[1][0]).toBe(textFile);

  const selected = new DataTransfer();
  selected.items.add(imageFile);
  selected.items.add(textFile);
  imageInput.files = selected.files;
  imageInput.dispatchEvent(new Event("change", { bubbles: true }));
  expect(attachments[2]).toEqual([imageFile, textFile]);
  expect(attachments[2][0]).toBe(imageFile);
  expect(attachments[2][1]).toBe(textFile);
  const captured = new File(["camera original"], "camera.heic", { type: "image/heic" });
  const cameraFiles = new DataTransfer();
  cameraFiles.items.add(captured);
  cameraInput.files = cameraFiles.files;
  cameraInput.dispatchEvent(new Event("change", { bubbles: true }));
  expect(attachments[3][0]).toBe(captured);
  expect(cameraInput.value).toBe("");
});

test.each([1280, 390])("keeps the file input mounted after menu close and resets repeated selections at %ipx", async (width) => {
  await page.viewport(width, 844);
  const attachments: File[][] = [];
  const screen = await renderPwa(<ComposerHarness onAddFiles={files => attachments.push(files)} />);
  try {
    const [imageInput, cameraInput] = getImageInputs();
    const trigger = screen.getByRole("button", { name: "Add attachments" });
    let chooserOpens = 0;
    imageInput.addEventListener("click", (event) => {
      event.preventDefault();
      chooserOpens += 1;
    });
    expect(getComputedStyle(imageInput).display).toBe("none");
    expect(imageInput.closest('[role="menu"]')).toBeNull();

    const openChooser = async () => {
      trigger.element().focus();
      await trigger.click();
      const choose = screen.getByRole("menuitem", { name: "Choose files", exact: true });
      // 等非零入场和初始 FocusTrap placeholder 稳定，再模拟用户选择。
      await expect.poll(() => getComputedStyle(choose.element().closest('[role="menu"]')!).opacity).toBe("1");
      choose.element().focus();
      await expect.element(choose).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await expect.element(choose).not.toBeInTheDocument();
      await expect.element(trigger).toHaveFocus();
      expect(imageInput.isConnected).toBe(true);
      expect(getImageInputs()[0]).toBe(imageInput);
    };

    await openChooser();
    imageInput.dispatchEvent(new Event("cancel", { bubbles: true }));
    imageInput.files = new DataTransfer().files;
    imageInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(attachments).toEqual([]);

    const file = new File(["image"], "chosen.webp", { type: "image/webp" });
    for (let selection = 0; selection < 2; selection += 1) {
      await openChooser();
      const transfer = new DataTransfer();
      transfer.items.add(file);
      imageInput.files = transfer.files;
      expect(imageInput.value).toContain("chosen.webp");
      imageInput.dispatchEvent(new Event("change", { bubbles: true }));
      await expect.poll(() => attachments.length).toBe(selection + 1);
      expect(attachments[selection][0]).toBe(file);
      expect(imageInput.value).toBe("");
      expect(imageInput.files).toHaveLength(0);
      expect(cameraInput.files).toHaveLength(0);
      await screen.getByRole("button", { name: "Remove chosen.webp" }).click();
    }
    expect(chooserOpens).toBe(3);
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("navigates Pi commands to model and thinking choices, reports opens, and closes after each selection", async () => {
  let commandOpens = 0;
  const selectedModels: WireModel[] = [];
  const selectedThinking: ThinkingLevel[] = [];
  const screen = await renderPwa(
    <ComposerHarness
      onCommandsOpen={() => { commandOpens += 1; }}
      onSetModel={(nextModel) => selectedModels.push(nextModel)}
      onSetThinking={(level) => selectedThinking.push(level)}
    />,
  );
  const commandTrigger = screen.getByRole("button", { name: "Pi commands" });

  await commandTrigger.click();
  expect(commandOpens).toBe(1);
  await screen.getByRole("menuitem", { name: /\/model/ }).click();
  const modelGroup = screen.getByRole("group", { name: "Change model" });
  await expect.element(modelGroup).toBeVisible();
  await screen.getByRole("menuitem", { name: /anthropic \/ Claude Sonnet 4/ }).click();
  await expect.poll(() => selectedModels).toEqual([model]);
  await expect.element(modelGroup).not.toBeInTheDocument();

  await commandTrigger.click();
  expect(commandOpens).toBe(2);
  await screen.getByRole("menuitem", { name: /\/thinking/ }).click();
  const thinkingGroup = screen.getByRole("group", { name: "Thinking level" });
  await expect.element(thinkingGroup).toBeVisible();
  await expect.element(screen.getByLabelText("Current thinking level")).toBeVisible();
  await screen.getByRole("menuitem", { name: "high", exact: true }).click();
  await expect.poll(() => selectedThinking).toEqual(["high"]);
  await expect.element(thinkingGroup).not.toBeInTheDocument();
});

test("resets a closing subview even when reopened before the fade completes", async () => {
  const screen = await renderPwa(<ComposerHarness />);
  const trigger = screen.getByRole("button", { name: "Pi commands" });
  await trigger.click();
  await screen.getByRole("menuitem", { name: /\/model/ }).click();
  await expect.element(screen.getByRole("menuitem", { name: "Back", exact: true })).toBeVisible();
  (trigger.element() as HTMLElement).click();
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  (trigger.element() as HTMLElement).click();
  await expect.element(screen.getByRole("menuitem", { name: /\/new/ })).toBeVisible();
  await expect.element(screen.getByRole("menuitem", { name: "Back", exact: true })).not.toBeInTheDocument();
  await screen.unmount();
});

test.each([false, true])("hands off a double-triggered action once after menu removal (parent unmount=%s)", async unmount => {
  const menusAtCallback: Array<Element | null> = [];
  const screen = await renderPwa(<ComposerHarness onNewSession={() => menusAtCallback.push(document.querySelector(".pwa-command-menu-dropdown"))} />);
  const trigger = screen.getByRole("button", { name: "Pi commands" });
  await trigger.click();
  const item = screen.getByRole("menuitem", { name: /\/new/ }).element();
  item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  if (unmount) await screen.unmount();
  else (trigger.element() as HTMLElement).click(); // pending action 期间不能打断退出并重开。
  await expect.poll(() => menusAtCallback).toEqual([null]);
  if (!unmount) {
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect.element(screen.getByRole("menuitem", { name: /\/new/ })).toBeVisible();
    await screen.unmount();
  }
});

test("gates root Pi commands while working and disables every command when an action is pending", async () => {
  const screen = await renderPwa(<ComposerHarness initialWorking />);
  await screen.getByRole("button", { name: "Pi commands" }).click();
  const newSession = screen.getByRole("menuitem", { name: /\/new/ });
  const modelCommand = screen.getByRole("menuitem", { name: /\/model/ });
  await expect.element(newSession).toBeDisabled();
  await expect.element(modelCommand).toBeEnabled();

  screen.getByTestId("composer-set-command-pending").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await expect.element(modelCommand).toBeDisabled();
  await expect.element(screen.getByRole("menuitem", { name: /\/thinking/ })).toBeDisabled();
});

test("keeps Back enabled after thinking choices become pending", async () => {
  const screen = await renderPwa(<ComposerHarness />);
  const trigger = screen.getByRole("button", { name: "Pi commands" });
  trigger.element().focus();
  await userEvent.keyboard("{ArrowUp}");
  // 等菜单把焦点移到最后一项再确认，避免负载较高时 Enter 先于焦点移动到达。
  await expect.element(screen.getByRole("menuitem", { name: /\/thinking/ })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const back = screen.getByRole("menuitem", { name: "Back", exact: true });
  await expect.element(back).toHaveFocus();
  screen.getByTestId("composer-set-command-pending").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await expect.element(screen.getByRole("menuitem", { name: "high", exact: true })).toBeDisabled();
  await expect.element(back).toBeEnabled();
  await userEvent.keyboard("{End}");
  await expect.element(back).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement).not.toBe(document.body);
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
});

test("updates Stop and Send client state through working, stopping, image sending, and offline transitions", async () => {
  let stopCalls = 0;
  let sendCalls = 0;
  const screen = await renderPwa(
    <ComposerHarness
      onStop={() => { stopCalls += 1; }}
      onSend={() => { sendCalls += 1; }}
    />,
  );
  const textarea = screen.getByRole("textbox");

  await expect.element(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  screen.getByTestId("composer-toggle-working").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const stop = screen.getByRole("button", { name: "Stop current task" });
  await expect.element(stop).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Send message" })).not.toBeInTheDocument();
  await stop.click();
  expect(stopCalls).toBe(1);

  screen.getByTestId("composer-set-draft").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await expect.element(textarea).toHaveValue("Continue this task");
  await expect.element(screen.getByRole("button", { name: "Send message" })).not.toBeInTheDocument();
  expect(sendCalls).toBe(0);

  screen.getByTestId("composer-set-stopping").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await expect.element(screen.getByRole("button", { name: "Stopping current task" })).toBeDisabled();

  screen.getByTestId("composer-set-attachment").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  screen.getByTestId("composer-set-sending-image").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await expect.element(textarea).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Remove Queued image" })).toBeEnabled();
  await expect.element(screen.getByRole("button", { name: "Send message" })).not.toBeInTheDocument();

  screen.getByTestId("composer-go-offline").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const offlineSend = screen.getByRole("button", { name: "Send message" });
  await expect.element(offlineSend).toBeDisabled();
  await expect.element(textarea).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Pi commands" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Add attachments" })).toBeDisabled();
});

test("prevents duplicate native submits until an asynchronous send settles, then permits the next submit", async () => {
  let attempts = 0;
  let completed = false;
  let resolveSend!: () => void;
  const pendingSend = new Promise<void>((resolve) => {
    resolveSend = resolve;
  });
  const screen = await renderPwa(
    <ComposerHarness
      initialDraft="Review this change"
      onSend={() => {
        attempts += 1;
        return pendingSend.then(() => { completed = true; });
      }}
    />,
  );
  const form = document.querySelector<HTMLFormElement>("form.pwa-composer");
  expect(form).not.toBeNull();

  expect(form!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))).toBe(false);
  expect(form!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))).toBe(false);
  const attemptsBeforeCompletion = attempts;

  resolveSend();
  await expect.poll(() => completed).toBe(true);
  expect(form!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))).toBe(false);

  expect(attemptsBeforeCompletion).toBe(1);
  expect(attempts).toBe(2);
  await expect.element(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
});

test.each([[1280, 900], [390, 844]])("shows the current model beside Send and opens its choices directly at %ix%i", async (width, height) => {
  await page.viewport(width, height);
  let modelChoices = 0;
  let opens = 0;
  const other: WireModel = { ...model, id: "other-model", name: "Other Model" };
  const screen = await renderPwa(<ComposerHarness commandModels={[model, other]} onCommandsOpen={() => { opens += 1; }} onSetModel={() => { modelChoices += 1; }} />);
  try {
    const chip = screen.getByRole("button", { name: "Change model, current Claude Sonnet 4, thinking level medium" });
    await expect.element(chip).toBeVisible();
    const chipElement = chip.element();
    const send = screen.getByRole("button", { name: "Send message" }).element();
    // 模型标签在发送按钮左侧、点击区 44px；桌面同时显示思考级别，手机只显示模型名。
    expect(chipElement.getBoundingClientRect().right).toBeLessThanOrEqual(send.getBoundingClientRect().left);
    expect(chipElement.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    const thinking = chipElement.querySelector<HTMLElement>(".pwa-composer-model-thinking")!;
    if (width < 768) expect(getComputedStyle(thinking).display).toBe("none");
    else expect(getComputedStyle(thinking).display).not.toBe("none");
    await chip.click();
    await expect.element(screen.getByRole("group", { name: "Change model" })).toBeVisible();
    expect(opens).toBe(1);
    await screen.getByRole("menuitem", { name: /anthropic \/ Other Model/ }).click();
    await expect.poll(() => modelChoices).toBe(1);
    await expect.element(screen.getByRole("group", { name: "Change model" })).not.toBeInTheDocument();
    await expect.element(chip).toHaveFocus();
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("keeps the model menu and the Pi command menu exclusive, closes on Escape, and disables the model chip offline", async () => {
  const screen = await renderPwa(<ComposerHarness />);
  try {
    await screen.getByRole("button", { name: "Pi commands" }).click();
    await expect.element(screen.getByRole("menuitem", { name: /\/new/ })).toBeVisible();
    const chip = screen.getByRole("button", { name: /^Change model, current/ });
    await chip.click();
    await expect.element(screen.getByRole("group", { name: "Change model" })).toBeVisible();
    await expect.element(screen.getByRole("menuitem", { name: /\/new/ })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("group", { name: "Change model" })).not.toBeInTheDocument();
    await expect.element(chip).toHaveFocus();

    screen.getByTestId("composer-go-offline").element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await expect.element(chip).toBeDisabled();
  } finally {
    await screen.unmount();
  }
});
