import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./app/globals.css";
import { PwaApp } from "@/components/pwa/pwa-app";
import { PwaAppShell } from "@/components/pwa/pwa-app-shell";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";

const root = document.getElementById("root");
if (!root) throw new Error("Missing PWA root element");

const appRoot = createRoot(root);

// 开发评审不挂载连接、数据库或 Service Worker；生产构建会移除整个动态入口。
const reviewPath = import.meta.env.DEV ? window.location.pathname : "";

if (reviewPath === "/app/ui-review") {
  void import("./dev/ui-review").then(({ UiReviewPage }) => {
    appRoot.render(<StrictMode><UiReviewPage /></StrictMode>);
  });
} else if (reviewPath === "/app/ui-review-stage-a") {
  void import("./dev/ui-review-stage-a").then(({ UiReviewStageAPage }) => {
    appRoot.render(<StrictMode><UiReviewStageAPage /></StrictMode>);
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
