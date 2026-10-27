import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ATTACHMENT_MESSAGE_TYPE, ATTACHMENT_METADATA_TYPE } from "@pi-reach/protocol/session";
import { afterEach, describe, expect, test } from "vitest";
import { safeAttachmentFileName } from "../attachments/storage-path.js";
import { AttachmentSourceResolver, branchAttachment } from "./attachment-source.js";

const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ATTACHMENT_ID = "5f0c2d1e-0000-4000-8000-000000000001";

function descriptor(fileName = "photo:1.png", attachmentId = ATTACHMENT_ID) {
  return { attachment_id: attachmentId, file_name: fileName, mime_type: "image/png", byte_length: 5, sha256: sha("hello") };
}

function recordAttachment(manager: SessionManager, options: { bind?: boolean; fileName?: string; attachmentId?: string } = {}) {
  const ids = { version: 1 as const, client_request_id: `request-${options.attachmentId ?? "a"}`, sender_ref: "sender-1" };
  manager.appendCustomEntry(ATTACHMENT_METADATA_TYPE, { ...ids, text: "", attachments: [descriptor(options.fileName, options.attachmentId)] });
  if (options.bind !== false) manager.appendCustomEntry(ATTACHMENT_MESSAGE_TYPE, { ...ids, message_id: `message-${options.attachmentId ?? "a"}` });
}

async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "pi-reach-attachment-source-")));
  cleanup.push(path);
  return path;
}

async function original(base: string, date: string, fileName = "photo:1.png", attachmentId = ATTACHMENT_ID) {
  const directory = join(base, date, attachmentId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, safeAttachmentFileName(fileName));
  await writeFile(path, "hello");
  return path;
}

describe("branchAttachment", () => {
  test("only accepts attachments bound to a committed message on the current branch", () => {
    const manager = SessionManager.inMemory(process.cwd());
    recordAttachment(manager, { bind: false });
    expect(branchAttachment(manager, ATTACHMENT_ID)).toBeNull();
    const fork = manager.getLeafId();
    manager.appendCustomEntry(ATTACHMENT_MESSAGE_TYPE, { version: 1, client_request_id: "request-a", sender_ref: "sender-1", message_id: "message-a" });
    expect(branchAttachment(manager, ATTACHMENT_ID)).toMatchObject({ file_name: "photo:1.png", byte_length: 5 });
    manager.branch(fork!);
    manager.appendCustomEntry("unrelated", {});
    expect(branchAttachment(manager, ATTACHMENT_ID)).toBeNull();
  });
});

describe("AttachmentSourceResolver", () => {
  test("derives the dated storage path and returns upload metadata", async () => {
    const base = await root();
    await mkdir(join(base, "2026-10-01"));
    const path = await original(base, "2026-10-26");
    const manager = SessionManager.inMemory(process.cwd());
    recordAttachment(manager);
    const resolved = await new AttachmentSourceResolver(base).resolve(manager, ATTACHMENT_ID);
    expect(resolved).toEqual({ sourcePath: path, fileName: "photo:1.png", byteLength: 5, sha256: sha("hello") });
  });

  test("finds early per-session .bin originals", async () => {
    const base = await root();
    const manager = SessionManager.inMemory(process.cwd());
    recordAttachment(manager);
    const directory = join(base, sha(manager.getSessionId()));
    await mkdir(directory);
    await writeFile(join(directory, `${ATTACHMENT_ID}.bin`), "hello");
    expect(await new AttachmentSourceResolver(base).resolve(manager, ATTACHMENT_ID))
      .toMatchObject({ sourcePath: join(directory, `${ATTACHMENT_ID}.bin`), fileName: "photo:1.png" });
  });

  test("rejects unknown, path-like and off-branch ids without touching the disk layout", async () => {
    const base = await root();
    await original(base, "2026-10-26");
    const manager = SessionManager.inMemory(process.cwd());
    const resolver = new AttachmentSourceResolver(base);
    expect(await resolver.resolve(manager, ATTACHMENT_ID)).toBeNull();
    recordAttachment(manager);
    expect(await resolver.resolve(manager, "../2026-10-26")).toBeNull();
    expect(await resolver.resolve(manager, "other-id")).toBeNull();
  });

  test("returns null when the original directory is missing or a symbolic link", async () => {
    const base = await root();
    const manager = SessionManager.inMemory(process.cwd());
    recordAttachment(manager);
    expect(await new AttachmentSourceResolver(base).resolve(manager, ATTACHMENT_ID)).toBeNull();
    const elsewhere = await root();
    await mkdir(join(base, "2026-10-26"));
    await symlink(elsewhere, join(base, "2026-10-26", ATTACHMENT_ID));
    expect(await new AttachmentSourceResolver(base).resolve(manager, ATTACHMENT_ID)).toBeNull();
    expect(await new AttachmentSourceResolver(join(base, "missing")).resolve(manager, ATTACHMENT_ID)).toBeNull();
  });

  test("reuses a located path but still re-checks branch eligibility", async () => {
    const base = await root();
    const path = await original(base, "2026-10-26");
    const manager = SessionManager.inMemory(process.cwd());
    const fork = manager.appendCustomEntry("start", {});
    recordAttachment(manager);
    const resolver = new AttachmentSourceResolver(base);
    expect(await resolver.resolve(manager, ATTACHMENT_ID)).toMatchObject({ sourcePath: path });
    await rm(join(base, "2026-10-26"), { recursive: true });
    expect(await resolver.resolve(manager, ATTACHMENT_ID)).toMatchObject({ sourcePath: path });
    manager.branch(fork);
    expect(await resolver.resolve(manager, ATTACHMENT_ID)).toBeNull();
  });
});
