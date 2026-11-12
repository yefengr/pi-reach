import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";

type DragLike = { dataTransfer: DataTransfer | null };

/** 只识别带文件的拖动；拖动文字、链接仍交给浏览器原生处理（如拖进输入框插入文字）。 */
export function dragHasFiles(event: DragLike): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * 输入区的文件拖放目标。dragenter／dragleave 会在子元素之间成对触发，用计数判断指针是否仍在目标内；
 * 不可添加时不拦截，交给应用级守卫显示禁止标记，避免浏览器打开文件。
 */
export function useFileDropTarget({ disabled, onFiles }: { disabled: boolean; onFiles: (files: File[]) => void }) {
  const depthRef = useRef(0);
  const [inside, setInside] = useState(false);
  const leave = () => { depthRef.current = 0; setInside(false); };

  const handlers = {
    onDragEnter(event: ReactDragEvent<HTMLElement>) {
      if (!dragHasFiles(event)) return;
      depthRef.current += 1;
      setInside(true);
    },
    onDragLeave(event: ReactDragEvent<HTMLElement>) {
      if (!dragHasFiles(event)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setInside(false);
    },
    onDragOver(event: ReactDragEvent<HTMLElement>) {
      if (disabled || !dragHasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDrop(event: ReactDragEvent<HTMLElement>) {
      if (!dragHasFiles(event)) return;
      leave();
      if (disabled) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files);
      if (files.length) onFiles(files);
    },
  };
  return { active: inside && !disabled, handlers };
}

/** 应用内没有接收文件的位置时，拦截文件拖放：不让浏览器离开应用去打开文件，并显示禁止标记。 */
export function usePreventFileNavigation() {
  useEffect(() => {
    const guard = (event: DragEvent) => {
      if (event.defaultPrevented || !dragHasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);
}
