import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Share } from "lucide-react";
import { detectInstallGuide, readInstallGuideEnvironment, type InstallGuide } from "@/lib/pwa/install-guide";
import { useI18n } from "@/lib/i18n";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/** 当前可用的安装方式：浏览器可直接调起系统安装（`prompt`），或只能由用户手动添加。 */
export type InstallOffer = "prompt" | InstallGuide;

export type PwaInstallState = {
  /** 已从主屏幕、程序坞或应用窗口打开，或浏览器两种方式都不提供时为 null。 */
  offer: InstallOffer | null;
  /** 首次打开时选择「先在浏览器中使用」；与浏览器能力提示的关闭一样只在本次打开期间生效。 */
  deferred: boolean;
  setDeferred: (deferred: boolean) => void;
  /** 调起系统安装；无论用户接受还是取消，浏览器都会作废这次事件。 */
  install: () => Promise<void>;
};

const NO_INSTALL: PwaInstallState = { offer: null, deferred: false, setDeferred: () => {}, install: async () => {} };

/** 测试与状态展厅可直接提供受控值；未挂载 Provider 时视为不可安装。 */
export const PwaInstallContext = createContext<PwaInstallState>(NO_INSTALL);

export function usePwaInstall(): PwaInstallState {
  return useContext(PwaInstallContext);
}

function detectInitialGuide(): InstallGuide | null {
  // 不支持 Service Worker 的浏览器无法离线启动，不引导手动添加。
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  return detectInstallGuide(readInstallGuideEnvironment());
}

/**
 * 安装状态入口级挂载：`beforeinstallprompt` 可能在工作区渲染前触发，
 * 首次打开的引导与设置页共享同一事件，且不随 Service Worker 注册或提示展示位置重置。
 */
export function PwaInstallProvider({ children }: { children: ReactNode }) {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [guide, setGuide] = useState<InstallGuide | null>(detectInitialGuide);
  const [deferred, setDeferred] = useState(false);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setPrompt(null);
      setGuide(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!prompt) return;
    await prompt.prompt();
    await prompt.userChoice;
    setPrompt(null);
  }, [prompt]);

  const value = useMemo<PwaInstallState>(() => ({
    offer: prompt ? "prompt" : guide,
    deferred,
    setDeferred,
    install,
  }), [deferred, guide, install, prompt]);

  return <PwaInstallContext.Provider value={value}>{children}</PwaInstallContext.Provider>;
}

/** 各安装方式的标题与一句说明，首次打开与设置页共用。 */
export function useInstallCopy(offer: InstallOffer): { title: string; lead: string } {
  const n = useI18n().t.install;
  if (offer === "ios") return { title: n.iosTitle, lead: n.iosLead };
  if (offer === "mac-safari") return { title: n.macSafariTitle, lead: n.macSafariLead };
  return { title: n.promptTitle, lead: n.promptLead };
}

/**
 * 手动添加的步骤；可直接安装时没有步骤。首次打开时最后一步提示从新入口打开后再配对，
 * 设置页里用户通常已配对，只说明从新入口打开。
 */
export function InstallSteps({ offer, thenPair }: { offer: InstallOffer; thenPair: boolean }) {
  const n = useI18n().t.install;
  if (offer === "prompt") return null;
  const steps: ReactNode[] = offer === "ios"
    ? [<>{n.iosShare}<Share className="pwa-install-step-icon" size={16} aria-hidden="true" /></>, n.iosAdd, thenPair ? n.iosOpenThenPair : n.iosOpen]
    : [n.macSafariAdd, thenPair ? n.macSafariOpenThenPair : n.macSafariOpen];
  return <ol className="pwa-install-steps">
    {steps.map((step, index) => <li key={index}><span className="pwa-install-step-number" aria-hidden="true">{index + 1}.</span><span>{step}</span></li>)}
  </ol>;
}
