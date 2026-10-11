import { useEffect, useState } from "react";

/** 300ms 内完成不显示加载态；一旦显示，至少保持 500ms。 */
export function useDelayedVisibility(active: boolean, delay = 300, minimum = 500): boolean {
  const [visible, setVisible] = useState(false);
  const [shownAt, setShownAt] = useState<number | null>(null);
  useEffect(() => {
    if (active && !visible) {
      const timer = window.setTimeout(() => { setVisible(true); setShownAt(Date.now()); }, delay);
      return () => window.clearTimeout(timer);
    }
    if (!active && visible) {
      const remaining = Math.max(0, minimum - (Date.now() - (shownAt ?? 0)));
      const timer = window.setTimeout(() => { setVisible(false); setShownAt(null); }, remaining);
      return () => window.clearTimeout(timer);
    }
  }, [active, delay, minimum, shownAt, visible]);
  return visible;
}
