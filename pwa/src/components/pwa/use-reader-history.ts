import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

type ReaderHistoryOptions = {
  opened: boolean;
  /** 写入 history.state 的字段名，用来识别并撤回本阅读器压入的记录。 */
  stateKey: string;
  /** 写入该字段的值；撤回时按它判断记录仍属于本阅读器。 */
  marker: string | true;
  onClose: () => void;
  /** 为 true 时忽略本次后退（例如上层 Modal 正在处理）。 */
  ignorePop?: () => boolean;
};

/**
 * 阅读器打开时压入一条不改变 URL 的历史记录，系统返回与浏览器后退只关闭阅读器。
 * 系统已提供原生返回转场（`hasUAVisualTransition`，如 iOS 边缘手势）时，同步提交关闭并返回 `instant`，
 * 由调用方把退出时长置 0，避免在原生转场之上再播放一次退出动画。
 */
export function useReaderHistory({ opened, stateKey, marker, onClose, ignorePop }: ReaderHistoryOptions): { instant: boolean } {
  const [instant, setInstant] = useState(false);
  const [seenOpened, setSeenOpened] = useState(opened);
  if (seenOpened !== opened) {
    setSeenOpened(opened);
    // 重新打开后恢复正常退出动画。
    if (opened) setInstant(false);
  }
  const onCloseRef = useRef(onClose);
  const ignorePopRef = useRef(ignorePop);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    ignorePopRef.current = ignorePop;
  }, [onClose, ignorePop]);

  useEffect(() => {
    if (!opened) return;
    let pushed = false;
    let closedByHistory = false;
    // 推迟到下一轮任务再写历史，避免开发模式的重复挂载写入两条记录。
    const timer = window.setTimeout(() => {
      window.history.pushState({ ...(window.history.state ?? {}), [stateKey]: marker }, "");
      pushed = true;
    }, 0);
    const onPopState = (event: PopStateEvent) => {
      if (!pushed || ignorePopRef.current?.()) return;
      closedByHistory = true;
      const close = () => {
        if (event.hasUAVisualTransition === true) setInstant(true);
        onCloseRef.current();
      };
      // UA 在事件返回后截取目标界面，原生转场时必须在返回前提交关闭。
      if (event.hasUAVisualTransition === true) flushSync(close);
      else close();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("popstate", onPopState);
      // 通过按钮、Escape 或遮罩关闭时撤回压入的记录，保持后退行为一致。
      if (pushed && !closedByHistory && window.history.state?.[stateKey] === marker) window.history.back();
    };
  }, [opened, stateKey, marker]);

  return { instant };
}
