import { describe, expect, it, vi } from "vitest";
import { ATTACHMENT_PREVIEW_MAX_BYTES, ATTACHMENT_PREVIEW_MAX_DIMENSION, attachmentPreviewSchema } from "@pi-reach/protocol/session";
import { prepareAttachmentFile } from "./attachment-upload-prepare";

describe("attachment file preparation", () => {
  it("generates a bounded JPEG preview without reencoding or mutating the PNG original and closes the bitmap", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 800;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#8461cc";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
    const original = new File([blob], "original.png", { type: "image/png" });
    const before = await original.arrayBuffer();
    const realCreate = globalThis.createImageBitmap.bind(globalThis);
    const bitmap = await realCreate(original);
    const close = vi.spyOn(bitmap, "close");
    const create = vi.spyOn(globalThis, "createImageBitmap").mockResolvedValueOnce(bitmap);
    try {
      const prepared = await prepareAttachmentFile(original);
      expect(prepared.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(prepared.preview).toBeDefined();
      expect(attachmentPreviewSchema.safeParse(prepared.preview).success).toBe(true);
      expect(prepared.preview!.byte_length).toBeLessThanOrEqual(ATTACHMENT_PREVIEW_MAX_BYTES);
      expect(Math.max(prepared.preview!.width, prepared.preview!.height)).toBe(ATTACHMENT_PREVIEW_MAX_DIMENSION);
      const decoded = Uint8Array.from(atob(prepared.preview!.data), (character) => character.charCodeAt(0));
      const jpeg = await realCreate(new Blob([decoded], { type: "image/jpeg" }));
      expect(jpeg.width).toBe(prepared.preview!.width);
      expect(jpeg.height).toBe(prepared.preview!.height);
      jpeg.close();
      expect(await original.arrayBuffer()).toEqual(before);
      expect(original.type).toBe("image/png");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      create.mockRestore();
      close.mockRestore();
    }
  });

  it("hashes arbitrary and empty files and omits previews for undecodable images", async () => {
    const empty = await prepareAttachmentFile(new File([], "empty.bin"));
    expect(empty).toEqual({ sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
    const invalidImage = new File(["not an image"], "broken.webp", { type: "image/webp" });
    const invalid = await prepareAttachmentFile(invalidImage);
    expect(invalid.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(invalid.preview).toBeUndefined();
    const text = await prepareAttachmentFile(new File(["document"], "notes.txt", { type: "text/plain" }));
    expect(text.preview).toBeUndefined();
  });
});
