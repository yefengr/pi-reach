import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./app/globals.css";
import { applyStoredTextSize, shouldRestoreTextSize } from "@/lib/ui/text-size";

const root = document.getElementById("root");
if (!root) throw new Error("Missing PWA root element");

// 开发评审不挂载连接、数据库或 Service Worker；生产构建会移除整个动态入口。
const reviewPath = import.meta.env.DEV ? window.location.pathname : "";
// 渲染前恢复字号，避免首屏先按标准档排版再跳变；展厅保持受控字号。
const diagnostics = window.location.pathname === "/app/keyboard-diagnostics";
if (!diagnostics && shouldRestoreTextSize(reviewPath)) applyStoredTextSize();

const appRoot = createRoot(root);

if (diagnostics) {
  void import("./diagnostics/keyboard-diagnostics-page").then(({ KeyboardDiagnosticsPage }) => {
    appRoot.render(<StrictMode><KeyboardDiagnosticsPage /></StrictMode>);
  });
} else if (reviewPath === "/app/ui-review") {
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
  void import("./components/pwa/pwa-app-entry").then(({ PwaAppEntry }) => {
    appRoot.render(<StrictMode><PwaAppEntry /></StrictMode>);
  });
}
