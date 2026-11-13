import { createRef, useMemo, useState } from "react";
import { NativeSelect } from "@mantine/core";
import { PwaInstallContext, type InstallOffer, type PwaInstallState } from "@/components/pwa/pwa-install";
import { ChoosePiWorkspace, ConnectionIssueWorkspace, TimelineWorkspace, UnpairedWorkspace } from "@/components/pwa/workspace-content";
import { describeStartupFailure, StartupErrorView, StartupLoading } from "@/components/pwa/pwa-startup";
import { PwaStatusError } from "@/components/pwa/pwa-app-actions";
import { ServiceWorkerNotice } from "@/components/pwa/service-worker-register";
import { MessageList } from "@/components/pwa/message-list";
import { ReadOnlyComposer } from "@/components/pwa/message-composer";
import { useI18n } from "@/lib/i18n";
import { galleryItems } from "./ui-state-fixtures";
import { GALLERY_ENDPOINTS } from "./ui-state-shell-fixtures";

type MainScene = "first-run-prompt" | "first-run-ios" | "first-run-mac" | "choose-pi" | "relay-reconnecting" | "relay-retry" | "network"
  | "startup-loading" | "startup-error" | "status-error" | "exited" | "browser-notice";

const SCENES: { value: MainScene; label: string }[] = [
  { value: "first-run-prompt", label: "首次使用 · 可直接安装" },
  { value: "first-run-ios", label: "首次使用 · 添加到主屏幕" },
  { value: "first-run-mac", label: "首次使用 · 添加到程序坞" },
  { value: "choose-pi", label: "多个在线 Pi 待选择" },
  { value: "relay-reconnecting", label: "无法连接 Relay · 重连中" },
  { value: "relay-retry", label: "无法连接 Relay · 可立即重试" },
  { value: "network", label: "网络不可用" },
  { value: "startup-loading", label: "启动加载" },
  { value: "startup-error", label: "启动失败" },
  { value: "status-error", label: "会话内局部错误" },
  { value: "exited", label: "Pi 已退出 · 只读" },
  { value: "browser-notice", label: "浏览器能力提示" },
];
const FIRST_RUN_OFFERS: Partial<Record<MainScene, InstallOffer>> = { "first-run-prompt": "prompt", "first-run-ios": "ios", "first-run-mac": "mac-safari" };

/** 首次使用的安装引导：受控安装状态，不调起系统安装、不写偏好。 */
function FirstRun({ offer, onResult }: { offer: InstallOffer; onResult: (message: string) => void }) {
  const [deferred, setDeferred] = useState(false);
  const install: PwaInstallState = useMemo(() => ({ offer, deferred, setDeferred, install: async () => onResult("已演示安装；未调起系统安装。") }), [offer, deferred, onResult]);
  return <PwaInstallContext.Provider value={install}><UnpairedWorkspace onPair={() => onResult("已演示开始配对；未打开配对弹窗。")} /></PwaInstallContext.Provider>;
}

/** 主区空态、启动页与局部提示：直接复用正式组件，只由本页内存状态驱动。 */
export function UiStateMain() {
  const { t } = useI18n();
  const [scene, setScene] = useState<MainScene>("first-run-prompt");
  const [result, setResult] = useState("");
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const exitedItems = useMemo(() => galleryItems("offline", false), []);
  const offer = FIRST_RUN_OFFERS[scene];
  const changeScene = (next: MainScene) => { setScene(next); setResult(""); setErrorDismissed(false); setNoticeDismissed(false); };
  const content = offer ? <FirstRun key={scene} offer={offer} onResult={setResult} />
    : scene === "choose-pi" ? <ChoosePiWorkspace endpoints={GALLERY_ENDPOINTS} completedEndpointIds={new Set([GALLERY_ENDPOINTS[1].endpointId])} onSelect={() => setResult("已演示选择 Pi；未建立连接。")} />
      : scene === "relay-reconnecting" ? <ConnectionIssueWorkspace kind="relay" stage="reconnecting" busy onRetry={() => {}} retryDisabled />
        : scene === "relay-retry" ? <ConnectionIssueWorkspace kind="relay" stage="retry" busy={false} onRetry={() => setResult("已演示立即重试；不连接远程服务。")} retryDisabled={false} />
          : scene === "network" ? <ConnectionIssueWorkspace kind="network" stage="reconnecting" busy onRetry={() => {}} retryDisabled />
            : scene === "startup-loading" ? <StartupLoading />
              : scene === "startup-error" ? <StartupErrorView error={describeStartupFailure(new Error("startup_timeout"))} onRetry={() => setResult("已演示重新载入；页面保持原样。")} />
                : scene === "browser-notice" ? noticeDismissed ? null : <ServiceWorkerNotice onDismiss={() => setNoticeDismissed(true)} />
                  : <TimelineWorkspace
                    timeline={<MessageList items={exitedItems} hasEarlier={false} isLive={false} listRef={createRef()} bottomSentinelRef={createRef()} onScroll={() => {}} />}
                    footer={scene === "exited" ? <ReadOnlyComposer notice={t.workspace.exitedNote} modelName="model-standard" thinking="medium" /> : null} />;
  return <>
    <div className="pwa-ui-states-actions">
      <NativeSelect label="主区状态" value={scene} onChange={event => changeScene(event.currentTarget.value as MainScene)} data={SCENES} />
      {result ? <span role="status">{result}</span> : null}
    </div>
    {scene === "status-error" ? <div className="pwa-main-notices"><PwaStatusError message={errorDismissed ? null : "Could not update the conversation. Reconnect and try again."} onDismiss={() => setErrorDismissed(true)} /></div> : null}
    {content}
  </>;
}
