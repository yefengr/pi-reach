import { createContext, useContext, type ReactNode } from "react";
import type { ToolDetailsCacheScope } from "@/lib/pwa/tool-details-cache";
import type { ToolDetailsConnection, ToolDetailsController } from "@/lib/pwa/tool-details";
export type ToolDetailsView = {
  controller: ToolDetailsController;
  scope: ToolDetailsCacheScope | null;
  sourceKey: string | undefined;
  online: boolean;
  connection: () => ToolDetailsConnection | null;
};
const ToolDetailsContext = createContext<ToolDetailsView | null>(null);
export function ToolDetailsProvider({ value, children }: { value: ToolDetailsView; children: ReactNode }) {
  return <ToolDetailsContext.Provider value={value}>{children}</ToolDetailsContext.Provider>;
}
export function useToolDetailsView(): ToolDetailsView | null { return useContext(ToolDetailsContext); }
