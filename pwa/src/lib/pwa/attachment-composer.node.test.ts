import { describe, expect, test, vi } from "vitest";
import type { AttachmentDescriptor } from "@pi-reach/protocol/session";
import { AttachmentComposer, attachmentTargetKey, type AttachmentUploadPort, type AttachmentReadyMessage } from "./attachment-composer";
import type { TimelineScope } from "./timeline-runtime";
import type { AttachmentCapability, AttachmentUploadProgress } from "./attachment-upload-types";

const scope: TimelineScope = { deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime", sessionId: "session",
  selfSenderRef: "owner", channelId: "channel", leafId: "leaf" };
const context = { draftKey: "draft", draftVersion: 1 };
const file = (name: string) => new File(["original"], name, { type: "application/octet-stream" });
function descriptor(name: string): AttachmentDescriptor {
  return { attachment_id: `attachment-${name}`, file_name: name, mime_type: "application/octet-stream", byte_length: 8, sha256: "a".repeat(64) };
}
class UploadPort implements AttachmentUploadPort {
  readonly jobs = new Map<string, { file: File; resolve(value: AttachmentDescriptor): void; reject(error: unknown): void;
    progress(value: AttachmentUploadProgress): void; signal?: AbortSignal }>();
  readonly cancel = vi.fn(async () => undefined);
  readonly release = vi.fn();
  readonly disconnect = vi.fn();
  readonly dispose = vi.fn();
  readonly receive = vi.fn(() => false);
  lease = "lease";
  checking = false;
  constructor(readonly changed: (value: AttachmentCapability) => void) {}
  connect() { this.changed(this.checking ? { status: "checking" } : { status: "supported", uploadScope: this.lease }); }
  upload(source: File, id: string, progress: (value: AttachmentUploadProgress) => void, signal?: AbortSignal) {
    return new Promise<AttachmentDescriptor>((resolve, reject) => { this.jobs.set(id, { file: source, resolve, reject, progress, signal }); });
  }
  job(name: string) { return [...this.jobs.values()].findLast((job) => job.file.name === name)!; }
  async finish(name: string) { this.job(name).resolve(descriptor(name)); await Promise.resolve(); }
  async fail(name: string, code = "io_error") { this.job(name).reject({ code }); await Promise.resolve(); }
}
function setup(ready: (message: AttachmentReadyMessage) => boolean = () => true) {
  const clients: UploadPort[] = [];
  const onReady = vi.fn(ready);
  const composer = new AttachmentComposer({ onReady, onChange: vi.fn(), createClient: (changed) => {
    const client = new UploadPort(changed); clients.push(client); return client;
  } });
  composer.connect(scope, () => true);
  return { composer, onReady, clients, client: clients[0] };
}

describe("session attachment message intent", () => {
  test("selection stays local; ready sends once with only the final retained files", async () => {
    const { composer, client, onReady } = setup();
    composer.addFiles([file("one"), file("two")]);
    expect(client.jobs.size).toBe(0);
    expect(composer.start("Task", context)).toBe(true);
    expect(composer.start("Second", context)).toBe(false);
    const first = composer.snapshot().items[0];
    const firstJob = client.job("one");
    composer.remove(first.id);
    expect(firstJob.signal?.aborted).toBe(true);
    expect(client.job("two").signal?.aborted).toBe(false);
    firstJob.resolve(descriptor("one"));
    await client.finish("two");
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0][0]).toMatchObject({ text: "Task", attachments: [descriptor("two")] });
    expect(composer.snapshot().items).toEqual([]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test.each(["text", ""])('removing all files sends only nonempty text (%j)', (text) => {
    const { composer, onReady } = setup();
    composer.addFiles([file("one")]);
    composer.start(text, context);
    composer.remove(composer.snapshot().items[0].id);
    expect(onReady).toHaveBeenCalledTimes(text ? 1 : 0);
    if (text) expect(onReady.mock.calls[0][0]).toMatchObject({ text, attachments: [] });
    expect(composer.snapshot().active).toBe(false);
  });

  test("failed retained file blocks commit; retry never resends successful siblings", async () => {
    const { composer, client, onReady } = setup();
    composer.addFiles([file("one"), file("two")]);
    composer.start("", context);
    await client.finish("one");
    await client.fail("two");
    expect(composer.snapshot().issue).toBe("failed");
    expect(onReady).not.toHaveBeenCalled();
    const completed = client.job("one");
    const second = composer.snapshot().items[1];
    composer.retry(second.id);
    expect(client.job("one")).toBe(completed);
    await client.finish("two");
    expect(onReady.mock.calls[0][0].attachments).toHaveLength(2);
  });

  test("whole-intent cancellation keeps the original draft without auto-sending text", async () => {
    const { composer, client, onReady } = setup();
    composer.addFiles([file("one")]);
    composer.start("keep", context);
    const old = client.job("one");
    composer.cancelIntent();
    old.resolve(descriptor("one"));
    await Promise.resolve();
    expect(onReady).not.toHaveBeenCalled();
    expect(composer.snapshot().items[0]).toMatchObject({ fileName: "one", status: "draft" });
    expect(composer.snapshot().active).toBe(false);
    composer.start("retry", context);
    expect(client.job("one")).not.toBe(old);
    await client.finish("one");
    expect(onReady.mock.calls[0][0].text).toBe("retry");
  });

  test("target change cannot transfer files, returning restores the original local draft", async () => {
    const { composer, client, clients, onReady } = setup();
    composer.addFiles([file("one")]);
    composer.start("old", context);
    composer.connect({ ...scope, endpointId: "other" }, () => true);
    expect(composer.snapshot().items).toEqual([]);
    await client.finish("one");
    expect(onReady).not.toHaveBeenCalled();
    expect(clients[1].jobs.size).toBe(0);
    composer.connect({ ...scope, channelId: "new-channel" }, () => true);
    expect(composer.snapshot().items[0].status).toBe("draft");
    expect(composer.snapshot().active).toBe(false);
  });

  test("disconnect preserves intent; normal leaf/channel advance does not cancel it", async () => {
    const { composer, client, onReady } = setup();
    composer.addFiles([file("one")]);
    composer.start("resume", context);
    composer.disconnect();
    expect(composer.snapshot().issue).toBe("disconnected");
    expect(client.job("one").signal?.aborted).toBe(false);
    await client.finish("one");
    expect(onReady).not.toHaveBeenCalled();
    composer.connect({ ...scope, channelId: "reconnect", leafId: "later" }, () => true);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])("checking capability waits after removing files (all=%s), then resumes the same lease", async (all) => {
    const { composer, client, onReady } = setup();
    composer.addFiles([file("one"), file("two")]);
    composer.start("resume", context);
    await client.finish("one");
    composer.disconnect();
    client.checking = true;
    composer.connect({ ...scope, channelId: "reconnect" }, () => true);
    composer.remove(composer.snapshot().items[1].id);
    if (all) composer.remove(composer.snapshot().items[0].id);
    expect(onReady).not.toHaveBeenCalled();
    expect(composer.snapshot().active).toBe(true);
    client.changed({ status: "unknown" });
    expect(onReady).not.toHaveBeenCalled();
    client.changed({ status: "supported", uploadScope: "lease" });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0][0]).toMatchObject({ text: "resume", attachments: all ? [] : [descriptor("one")] });
  });

  test.each([false, true])("a different lease after checking cancels intent without sending (all=%s)", async (all) => {
    const { composer, client, onReady } = setup();
    composer.addFiles([file("one"), file("two")]);
    composer.start("keep text", context);
    await client.finish("one");
    composer.disconnect();
    client.checking = true;
    composer.connect({ ...scope, channelId: "reconnect" }, () => true);
    composer.remove(composer.snapshot().items[1].id);
    if (all) composer.remove(composer.snapshot().items[0].id);
    client.changed({ status: "supported", uploadScope: "different" });
    expect(onReady).not.toHaveBeenCalled();
    expect(composer.snapshot()).toMatchObject({ active: false, issue: "scope_changed" });
    expect(composer.snapshot().items).toHaveLength(all ? 0 : 1);
    if (!all) expect(composer.snapshot().items[0]).toMatchObject({ status: "draft", fileName: "one" });
  });

  test("preview IDs cover inactive targets and follow cancellation, removal, completion and disposal", async () => {
    const { composer, client } = setup();
    composer.addFiles([file("one")]);
    const originalId = composer.snapshot().items[0].id;
    composer.start("keep", context);
    composer.cancelIntent();
    expect(composer.previewItemIds()).toEqual([originalId]);
    composer.connect({ ...scope, endpointId: "other" }, () => true);
    composer.addFiles([file("other")]);
    const otherId = composer.snapshot().items[0].id;
    expect(composer.previewItemIds()).toEqual([originalId, otherId]);
    composer.remove(otherId);
    expect(composer.previewItemIds()).toEqual([originalId]);
    composer.connect(scope, () => true);
    composer.start("complete", context);
    await client.finish("one");
    expect(composer.previewItemIds()).toEqual([]);
    composer.addFiles([file("last")]);
    composer.dispose();
    expect(composer.previewItemIds()).toEqual([]);
  });

  test("a changed upload lease invalidates the batch but preserves the File draft", async () => {
    const { composer, client, onReady } = setup();
    composer.addFiles([file("one")]);
    composer.start("old", context);
    composer.disconnect();
    client.changed({ status: "checking" });
    client.lease = "new-branch";
    composer.connect({ ...scope, channelId: "new" }, () => true);
    await client.finish("one");
    expect(onReady).not.toHaveBeenCalled();
    expect(composer.snapshot()).toMatchObject({ active: false, issue: "scope_changed" });
    expect(composer.snapshot().items[0].status).toBe("draft");
  });

  test("sync commit gate rejects removal and duplicate submission from ready callback", async () => {
    const { composer, client, onReady } = setup(() => {
      composer.remove(composer.snapshot().items[0].id);
      expect(composer.start("duplicate", context)).toBe(false);
      return true;
    });
    composer.addFiles([file("one")]);
    composer.start("", context);
    await client.finish("one");
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(client.cancel).not.toHaveBeenCalled();
  });

  test.each([false, "throw"] as const)("failed handoff keeps complete originals for explicit retry (%s)", async (mode) => {
    let accept = false;
    const { composer, client, onReady } = setup(() => {
      if (!accept && mode === "throw") throw new Error("handoff failed");
      return accept;
    });
    composer.addFiles([file("one")]);
    composer.start("", context);
    await client.finish("one");
    expect(composer.snapshot()).toMatchObject({ active: false, issue: "send_failed" });
    const jobs = client.jobs.size;
    accept = true;
    composer.start("retry", context);
    expect(client.jobs.size).toBe(jobs);
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  test("queued cancellation restores only scoped descriptors, not fabricated Files", () => {
    const { composer, client, onReady } = setup();
    expect(composer.restoreAttachments([descriptor("queued")])).toBe(true);
    composer.start("restored", context);
    expect(client.jobs.size).toBe(0);
    expect(onReady.mock.calls[0][0].attachments).toEqual([descriptor("queued")]);
  });

  test("selection limits are atomic and unsupported capability never uploads", () => {
    const { composer, client } = setup();
    expect(composer.addFiles(Array.from({ length: 11 }, (_, index) => file(String(index))))).toBe("too_many");
    expect(composer.snapshot().items).toEqual([]);
    const invalid = new File(["x"], "bad\nname");
    expect(composer.addFiles([file("valid"), invalid])).toBe("invalid_file");
    expect(composer.snapshot().items).toEqual([]);
    client.changed({ status: "unsupported" });
    expect(composer.addFiles([file("one")])).toBe("unsupported");
    expect(composer.start("text", context)).toBe(false);
    expect(client.jobs.size).toBe(0);
  });

  test("target identity includes owner/runtime/session, not leaf or channel", () => {
    expect(attachmentTargetKey(scope)).toBe(attachmentTargetKey({ ...scope, leafId: "next", channelId: "next" }));
    for (const property of ["sessionId", "runtimeInstanceId", "selfSenderRef", "endpointId", "deviceId"] as const) {
      expect(attachmentTargetKey({ ...scope, [property]: "other" })).not.toBe(attachmentTargetKey(scope));
    }
  });
});
