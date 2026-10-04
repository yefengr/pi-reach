import type { ClientFrame, ServerFrame } from "../protocol/v2/index.js";
import type { AttachmentStore } from "../attachments/store.js";
import { handleAttachmentFrame, isAttachmentFrame } from "./attachment_binding.js";
import type { OwnerBinding } from "./create_owner_binding.js";
import { FileBinding, isFileFrame } from "./file_binding.js";

type RouterOptions = {
  getBinding: (ownerId: string) => OwnerBinding | undefined;
  getAttachments: () => AttachmentStore;
  files: FileBinding;
};

export function createSessionFrameRouter(options: RouterOptions): (ownerId: string, frame: ClientFrame) => void {
  return (ownerId, frame) => {
    const binding = options.getBinding(ownerId);
    if (!binding) return;
    const send = (frames: readonly ServerFrame[]) => {
      if (options.getBinding(ownerId) !== binding) return;
      for (const response of frames) binding.channel.sendV2(response);
    };
    if (isFileFrame(frame)) {
      void options.files.handle(frame, ownerId, binding).then(send);
      return;
    }
    if (isAttachmentFrame(frame)) {
      void handleAttachmentFrame(options.getAttachments(), binding.service, ownerId, frame).then(send);
      return;
    }
    send(binding.service.handle(frame));
  };
}
