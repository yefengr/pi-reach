import { createHash } from "node:crypto";
import { AttachmentStore, AttachmentStoreError } from "./store.js";

// 仅由隔离测试的 IPC 子进程调用；不使用默认附件目录。
const rootDir = process.argv[2];
const available = BigInt(process.argv[3]);
const allocationUnitBytes = Number(process.argv[4] ?? 1);
const contents = "x".repeat(Number(process.argv[5] ?? 4));
if (!rootDir || !process.send) throw new Error("Isolated fixture requires root and IPC");
const store = new AttachmentStore({
  rootDir, runtimeId: `fixture-${process.pid}`, minFreeBytes: 2,
  testHooks: { availableBytes: () => available, allocationUnitBytes },
});
const scope = { ownerId: "fixture-owner", sessionId: "session", uploadScope: store.scopeFor("session") };
process.on("message", (message: unknown) => {
  if (message !== "begin") return;
  void store.begin(scope, {
    uploadId: "fixture-upload", fileName: "fixture.bin", mimeType: "application/octet-stream", byteLength: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
  }).then(
    () => process.send?.({ type: "result", accepted: true }),
    (error: unknown) => process.send?.({ type: "result", accepted: false,
      code: error instanceof AttachmentStoreError ? error.code : "unexpected" }),
  );
});
process.send({ type: "ready" });
