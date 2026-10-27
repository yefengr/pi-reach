import { expect, test, vi } from "vitest";
import type { OwnerBinding } from "./create_owner_binding.js";
import type { FileBinding } from "./file_binding.js";
import { createSessionFrameRouter } from "./session_frame_router.js";

test("routes attachment original reads to the file reader, not the upload store", async () => {
  const handle = vi.fn(async () => []);
  const getAttachments = vi.fn();
  const binding = { channel: { sendV2: vi.fn() }, service: { handle: vi.fn(() => []) } } as unknown as OwnerBinding;
  const route = createSessionFrameRouter({ getBinding: () => binding, getAttachments, files: { handle } as unknown as FileBinding });
  route("owner", { protocol_version: 2, type: "file_attachment_open", id: "open", channel_id: "channel", session_id: "session", attachment_id: "attachment" });
  await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
  expect(getAttachments).not.toHaveBeenCalled();
  expect(binding.service.handle).not.toHaveBeenCalled();
});
