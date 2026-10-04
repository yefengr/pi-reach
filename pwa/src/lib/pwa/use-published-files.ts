import { useState, useSyncExternalStore } from "react";
import { FileTransferController, type FileTransferOptions } from "./file-transfer";

/** 只持有运行态；connect/disconnect/reset/dispose 由父入口统一管理，避免 StrictMode 重放提前终止。 */
export function usePublishedFiles(options?: FileTransferOptions) {
  const [controller] = useState(() => new FileTransferController(options));
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  return { controller, state };
}
