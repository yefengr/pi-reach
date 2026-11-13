import { useSyncExternalStore } from "react";
import { getTextSizeState, setTextSize, subscribeTextSize, supportsSystemTextSize, type PwaTextSize, type PwaTextSizePreference } from "@/lib/ui/text-size";

/** `textSize` 是当前生效的档位；`preference` 是用户的选择，可能为跟随系统。 */
export function usePwaTextSize(): Readonly<{ textSize: PwaTextSize; preference: PwaTextSizePreference; followsSystem: boolean; setTextSize: (preference: PwaTextSizePreference) => void }> {
  const { size, preference } = useSyncExternalStore(subscribeTextSize, getTextSizeState, getTextSizeState);
  return { textSize: size, preference, followsSystem: supportsSystemTextSize(), setTextSize };
}
