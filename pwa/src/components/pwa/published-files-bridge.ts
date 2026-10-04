import type { FileTransferController, FileTransferSnapshot } from "@/lib/pwa/file-transfer";
import type { PublishedFilesView } from "./published-files-context";

/** UI 只消费预览门面；缓冲、请求和 URL 的所有权仍归 controller。 */
export function publishedFilesView(controller: FileTransferController, _state: FileTransferSnapshot,
  canFetch: boolean, canFetchNow: () => boolean = () => canFetch, onReadingChange?: (reading: boolean) => void): PublishedFilesView {
  return {
    canFetch, get active() { return controller.snapshot().active; }, onReadingChange,
    getState: (id) => {
      const entry = controller.snapshot().files.get(id);
      if (!entry) return undefined;
      return {
        phase: entry.phase, receivedBytes: entry.receivedBytes,
        fileName: entry.current?.file_name, mimeType: entry.current?.mime_type,
        byteLength: entry.current?.byte_length, preview: entry.current?.preview,
        url: entry.result?.url, text: entry.result?.text, error: entry.error,
      };
    },
    open: (descriptor, intent) => {
      if (controller.snapshot().files.get(descriptor.publication_id)?.phase === "ready" || canFetchNow()) return controller.open(descriptor, intent);
      return Promise.resolve();
    },
    retry: (descriptor, intent) => canFetchNow() ? controller.retry(descriptor, intent) : Promise.resolve(),
    cancel: () => controller.cancel(), pin: (id) => controller.pin(id), unpin: (id) => controller.unpin(id),
  };
}
