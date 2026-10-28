import { useLayoutEffect, useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { getMessages } from "@/lib/i18n";
import { ATTACHMENT_CHUNK_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_IN_FLIGHT, ATTACHMENT_MAX_MESSAGE_BYTES } from "@pi-reach/protocol/session";
import { renderPwa } from "@/test/browser/render";
import { useAttachmentComposer } from "@/lib/pwa/use-attachment-composer";
import { MessageComposer } from "./message-composer";

const probe = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("./use-composer-autosize", async importOriginal => {
  const actual = await importOriginal<typeof import("./use-composer-autosize")>();
  return {
    ...actual,
    useComposerAutosize(...args: Parameters<typeof actual.useComposerAutosize>) {
      probe.render();
      return actual.useComposerAutosize(...args);
    },
  };
});

type Props = ComponentProps<typeof MessageComposer>;
const noop = () => {};
const base: Props = {
  enterSends: true, attachments: [], canAttach: true, sendingAttachments: false,
  isOnline: true, isWorking: false, stopping: false, draft: "Draft",
  onDraftChange: noop, onSend: noop, onStop: noop, onAddFiles: noop,
  onRemoveAttachment: noop, onRetryAttachment: noop,
  commandModels: [], commandCurrentModel: null, commandCurrentModelFallback: null,
  commandThinking: "off", commandPendingAction: null,
  onNewSession: noop, onCompactSession: noop, onSetModel: noop,
  onSetThinking: noop, onCommandsOpen: noop,
};
let update: (patch: Partial<Props>) => void;
let updateQueue: (version: number) => void;
function Harness() {
  const [props, setProps] = useState(base);
  const [queue, setQueue] = useState(0);
  useLayoutEffect(() => {
    update = patch => setProps(current => ({ ...current, ...patch }));
    updateQueue = setQueue;
  });
  return <MessageComposer {...props} queuedMessages={<span data-testid="queue">Queue {queue}</span>} />;
}

async function settleGeometry() {
  // 仅等待初始 ResizeObserver 的有限交接，不将初始化测量计入重复更新。
  for (let frame = 0; frame < 3; frame += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

afterEach(() => { probe.render.mockClear(); vi.restoreAllMocks(); });

test("timeline queue updates do not render the input body or replace its focused textarea", async () => {
  const screen = await renderPwa(<Harness />);
  try {
    const input = document.querySelector<HTMLTextAreaElement>(".pwa-composer-input")!;
    input.focus();
    const renders = probe.render.mock.calls.length;
    for (let version = 1; version <= 6; version += 1) flushSync(() => updateQueue(version));
    expect(document.querySelector('[data-testid="queue"]')?.textContent).toBe("Queue 6");
    expect(probe.render).toHaveBeenCalledTimes(renders);
    expect(document.querySelector(".pwa-composer-input")).toBe(input);
    expect(document.activeElement).toBe(input);
  } finally { await screen.unmount(); }
});

test("memoized input still applies changed draft, working state and the latest action callback", async () => {
  const oldSend = vi.fn();
  const latestSend = vi.fn();
  const latestStop = vi.fn();
  const screen = await renderPwa(<Harness />);
  try {
    flushSync(() => update({ onSend: oldSend }));
    flushSync(() => update({ draft: "Updated draft", onSend: latestSend }));
    expect(document.querySelector<HTMLTextAreaElement>(".pwa-composer-input")?.value).toBe("Updated draft");
    document.querySelector<HTMLFormElement>(".pwa-composer")!.requestSubmit();
    await expect.poll(() => latestSend.mock.calls.length).toBe(1);
    expect(oldSend).not.toHaveBeenCalled();
    flushSync(() => update({ draft: "", isWorking: true, onStop: latestStop }));
    await screen.getByRole("button", { name: getMessages().composer.stopTask }).click();
    expect(latestStop).toHaveBeenCalledOnce();
  } finally { await screen.unmount(); }
});

test("unrelated input props skip autosize while actual draft growth is measured", async () => {
  const screen = await renderPwa(<Harness />);
  try {
    await settleGeometry();
    const input = document.querySelector<HTMLTextAreaElement>(".pwa-composer-input")!;
    const clone = vi.spyOn(input, "cloneNode");
    flushSync(() => update({ onStop: vi.fn() }));
    expect(clone).not.toHaveBeenCalled();
    flushSync(() => update({ draft: "A longer draft\n".repeat(12) }));
    expect(clone).toHaveBeenCalled();
    expect(input.value).toContain("A longer draft\nA longer draft");
  } finally { await screen.unmount(); }
});

let attachmentApi: ReturnType<typeof useAttachmentComposer>;
let rerenderAttachments: () => void;
function AttachmentHarness() {
  const [, setVersion] = useState(0);
  const attachments = useAttachmentComposer(() => "not-handled", getMessages().attachments);
  useLayoutEffect(() => {
    attachmentApi = attachments;
    rerenderAttachments = () => setVersion(version => version + 1);
  });
  return <span>{attachments.items.length}</span>;
}

test("attachment snapshots stay stable on unrelated updates and refresh on real draft mutations", async () => {
  const screen = await renderPwa(<AttachmentHarness />);
  try {
    const initial = attachmentApi.items;
    flushSync(rerenderAttachments);
    expect(attachmentApi.items).toBe(initial);
    flushSync(() => attachmentApi.composer.connect({ deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime", sessionId: "session", leafId: null, selfSenderRef: "self", channelId: "channel" }, frame => {
      if (frame.type === "attachment_capabilities_request") queueMicrotask(() => attachmentApi.composer.receive({
        protocol_version: 2, type: "attachment_capabilities", in_reply_to: frame.id,
        target_channel_id: frame.channel_id, session_id: frame.session_id, upload_scope: "upload-scope",
        max_file_bytes: ATTACHMENT_MAX_FILE_BYTES, max_message_bytes: ATTACHMENT_MAX_MESSAGE_BYTES,
        max_attachments: ATTACHMENT_MAX_COUNT, chunk_bytes: ATTACHMENT_CHUNK_BYTES, max_in_flight: ATTACHMENT_MAX_IN_FLIGHT,
      }));
      return true;
    }));
    await expect.poll(() => attachmentApi.snapshot.capability.status).toBe("supported");
    flushSync(() => attachmentApi.addFiles([new File(["notes"], "notes.txt", { type: "text/plain" })]));
    expect(attachmentApi.items).toHaveLength(1);
    const withDraft = attachmentApi.items;
    flushSync(rerenderAttachments);
    expect(attachmentApi.items).toBe(withDraft);
    flushSync(() => attachmentApi.remove(withDraft[0]!.id));
    expect(attachmentApi.items).toHaveLength(0);
  } finally { await screen.unmount(); }
});
