import { useSyncExternalStore } from "react";
import { getTextSize, setTextSize, subscribeTextSize, type PwaTextSize } from "@/lib/ui/text-size";

export function usePwaTextSize(): Readonly<{ textSize: PwaTextSize; setTextSize: (size: PwaTextSize) => void }> {
  const textSize = useSyncExternalStore(subscribeTextSize, getTextSize, getTextSize);
  return { textSize, setTextSize };
}
