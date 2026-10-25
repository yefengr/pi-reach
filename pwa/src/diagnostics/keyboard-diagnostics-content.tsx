import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

/** 只测真实 Chrome；键盘补偿、密度与时间线仍由原控制器和滚动所有者负责。 */
export function KeyboardDiagnosticsContent({ controllerRef, chrome, children }: {
  controllerRef: RefObject<HTMLDivElement | null>; chrome: ReactNode; children: ReactNode;
}) {
  const chromeRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = chromeRef.current;
    const controller = controllerRef.current;
    if (!element || !controller) return;
    const measure = () => {
      const height = `${element.getBoundingClientRect().height}px`;
      if (controller.style.getPropertyValue("--diagnostics-chrome-height") !== height) {
        controller.style.setProperty("--diagnostics-chrome-height", height);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); controller.style.removeProperty("--diagnostics-chrome-height"); };
  }, [controllerRef]);
  return <>
    <div ref={chromeRef} className="pwa-keyboard-diagnostics-chrome">{chrome}</div>
    <div ref={controllerRef} className="pwa-app-shell pwa-keyboard-diagnostics-content">
      <div className="pwa-root" data-sidebar-collapsed><div className="pwa-main">
        <div className="pwa-keyboard-diagnostics-slot" aria-hidden="true" />
        {children}
      </div></div>
    </div>
  </>;
}
