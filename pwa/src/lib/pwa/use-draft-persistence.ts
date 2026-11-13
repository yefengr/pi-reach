import { useEffect, useRef } from "react";
import { writeStoredDrafts } from "./draft-storage";

/** 输入停顿这么久后落盘；页面隐藏或卸载时立即落盘，不等这段时间。 */
export const DRAFT_WRITE_DELAY_MS = 400;

/** 把草稿状态同步到本地存储：输入时防抖写入，页面转入后台或卸载前立即写入（主屏 PWA 在后台随时可能被系统回收）。 */
export function useDraftPersistence(drafts: Readonly<Record<string, string>>): void {
  const latest = useRef(drafts);
  const written = useRef(drafts);
  useEffect(() => {
    latest.current = drafts;
    if (written.current === drafts) return;
    const timer = window.setTimeout(() => { written.current = drafts; writeStoredDrafts(drafts); }, DRAFT_WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [drafts]);
  useEffect(() => {
    const flush = () => {
      if (written.current === latest.current) return;
      written.current = latest.current;
      writeStoredDrafts(latest.current);
    };
    const hidden = () => { if (document.hidden) flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
}
