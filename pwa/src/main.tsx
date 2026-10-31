import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./app/globals.css";
import { PwaApp } from "@/components/pwa/pwa-app";
import { PwaAppShell } from "@/components/pwa/pwa-app-shell";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";
import { applyStoredTextSize, shouldRestoreTextSize } from "@/lib/ui/text-size";
import { applyStoredMotionProfile } from "@/lib/ui/motion-profile";

const root = document.getElementById("root");
if (!root) throw new Error("Missing PWA root element");

// 开发评审不挂载连接、数据库或 Service Worker；生产构建会移除整个动态入口。
const reviewPath = import.meta.env.DEV ? window.location.pathname : "";
// 渲染前恢复字号与动效风格，避免首屏先按默认值排版或读取时长再跳变；展厅保持受控字号。
if (shouldRestoreTextSize(reviewPath)) {
  applyStoredTextSize();
  applyStoredMotionProfile();
}

const appRoot = createRoot(root);

if (reviewPath === "/app/ui-review") {
  void import("./dev/ui-review").then(({ UiReviewPage }) => {
    appRoot.render(<StrictMode><UiReviewPage /></StrictMode>);
  });
} else if (reviewPath === "/app/ui-review-stage-a") {
  void import("./dev/ui-review-stage-a").then(({ UiReviewStageAPage }) => {
    appRoot.render(<StrictMode><UiReviewStageAPage /></StrictMode>);
  });
} else if (reviewPath === "/app/ui-states") {
  void import("./dev/ui-states").then(({ UiStateGalleryPage }) => {
    appRoot.render(<StrictMode><UiStateGalleryPage /></StrictMode>);
  });
} else {
  appRoot.render(
    <StrictMode>
      <PwaUiProvider>
        <PwaAppShell runtimeNotice={<ServiceWorkerRegister />}>
          <PwaApp />
        </PwaAppShell>
      </PwaUiProvider>
    </StrictMode>,
  );
}
