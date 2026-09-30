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

createRoot(root).render(
  <StrictMode>
    <PwaUiProvider>
      <PwaAppShell runtimeNotice={<ServiceWorkerRegister />}>
        <PwaApp />
      </PwaAppShell>
    </PwaUiProvider>
  </StrictMode>,
);
