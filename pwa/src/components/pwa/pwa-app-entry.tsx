import { PwaApp } from "./pwa-app";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaUiProvider } from "./pwa-ui-provider";
import { ServiceWorkerRegister } from "./service-worker-register";

/** 只有正常入口加载业务运行态；隔离诊断不可导入本模块。 */
export function PwaAppEntry() {
  return <PwaUiProvider>
    <PwaAppShell runtimeNotice={<ServiceWorkerRegister />}><PwaApp /></PwaAppShell>
  </PwaUiProvider>;
}
