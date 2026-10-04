import { createContext, useContext, type ReactNode } from "react";
import type { FilePreview, PublishedFileDescriptor } from "@pi-reach/protocol/session";

export type PublishedFileViewState = {
  phase: "idle" | "opening" | "manual" | "reading" | "ready" | "error";
  fileName?: string;
  mimeType?: string;
  byteLength?: number;
  receivedBytes: number;
  preview?: FilePreview;
  url?: string;
  text?: string;
  error?: string;
};
export type PublishedFilesView = {
  readonly scopeToken: object;
  canFetch: boolean;
  active: boolean;
  getState: (id: string) => PublishedFileViewState | undefined;
  open: (descriptor: PublishedFileDescriptor, intent: "auto" | "view" | "download") => Promise<void>;
  retry?: (descriptor: PublishedFileDescriptor, intent: "view" | "download") => Promise<void>;
  cancel: () => void;
  pin: (id: string) => void;
  unpin: (id: string) => void;
  onReadingChange?: (reading: boolean) => void;
};
const FilesContext = createContext<PublishedFilesView | null>(null);
export function PublishedFilesProvider({ value, children }: { value: PublishedFilesView; children: ReactNode }) {
  return <FilesContext.Provider value={value}>{children}</FilesContext.Provider>;
}
export function usePublishedFilesView(): PublishedFilesView | null {
  return useContext(FilesContext);
}
