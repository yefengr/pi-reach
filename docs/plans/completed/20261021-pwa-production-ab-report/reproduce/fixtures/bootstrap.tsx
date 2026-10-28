import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@/app/globals.css";
import { PwaApp } from "@/components/pwa/pwa-app";
import { PwaAppShell } from "@/components/pwa/pwa-app-shell";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";
import { setLanguagePreference } from "@/lib/i18n";
import { makePwaDeviceId, makePwaEndpointId, openPwaDatabase } from "@/lib/pwa/db";
import { toStoredKey } from "@/lib/pwa/runtime";
import { applyStoredTextSize } from "@/lib/ui/text-size";
import { createHistory, FIXTURE, historyCountFromUrl } from "./history";
import { configureTransport, fixtureErrors, receiveFrame, setWorking, transportSnapshot } from "./transports";

const PREPARATION_TIMEOUT_MS = 45_000;
let historyCount = 0;
let prepared = false;

function renderedHistory(): number {
  return [...document.querySelectorAll(".pwa-message-list article.assistant:not(.partial) h2")]
    .filter((heading) => /^History [1-9]\d*$/.test(heading.textContent ?? "")).length;
}

function fail(message: string): void {
  fixtureErrors.push(message);
  api.ready = false;
}

const api = {
  get ready(): boolean { return prepared && fixtureErrors.length === 0; },
  set ready(value: boolean) { prepared = value; },
  receive(frame: unknown): void {
    if (!api.ready) throw new Error("Fixture is not ready");
    receiveFrame(frame);
  },
  setWorking(value: boolean): void {
    if (!api.ready) throw new Error("Fixture is not ready");
    setWorking(value);
  },
  snapshot() {
    return {
      historyCount, renderedHistory: renderedHistory(), sessionId: FIXTURE.sessionId,
      leafId: FIXTURE.leafId, ...transportSnapshot(), errors: [...fixtureErrors],
    };
  },
  async savedEvents(): Promise<unknown[]> {
    const db = await openPwaDatabase();
    const records = await db.events.where("[deviceId+endpointId+sessionId]")
      .equals([FIXTURE.deviceId, FIXTURE.endpointId, FIXTURE.sessionId]).toArray();
    return records.sort((left, right) => (left.eventSeq ?? 0) - (right.eventSeq ?? 0)).map((record) => record.event);
  },
};

declare global { interface Window { __ab: typeof api } }
window.__ab = api;
window.addEventListener("error", () => fail("Uncaught browser error"));
window.addEventListener("unhandledrejection", () => fail("Unhandled browser rejection"));

async function prepareDatabase(): Promise<void> {
  const db = await openPwaDatabase();
  const tables = [db.identities, db.devices, db.endpoints, db.events, db.sessions, db.settings];
  const counts = await Promise.all(tables.map((table) => table.count()));
  if (counts.some((count) => count !== 0)) throw new Error("Fixture requires a fresh isolated browser context");
  const deviceId = makePwaDeviceId(FIXTURE.deviceId);
  await db.transaction("rw", [db.identities, db.devices, db.endpoints, db.settings], async () => {
    // 固定无效测试身份仅满足启动读取；离线运输不使用它签名、加密或访问网络。
    await db.identities.put({ id: "owner", publicKey: toStoredKey(new Uint8Array(32).fill(1)),
      secretKey: toStoredKey(new Uint8Array(32).fill(2)), createdAt: FIXTURE.timestamp });
    await db.devices.put({ id: deviceId, deviceId: FIXTURE.deviceId, relayUrl: FIXTURE.relayUrl,
      pairedAt: "2026-01-01T00:00:00.000Z", hostname: "Fixture computer" });
    await db.endpoints.put({ id: makePwaEndpointId(FIXTURE.deviceId, FIXTURE.endpointId),
      deviceId: FIXTURE.deviceId, endpointId: FIXTURE.endpointId,
      runtimeInstanceId: FIXTURE.runtimeInstanceId, kind: "interactive", name: "Performance fixture",
      cwd: "/ab", working: false, updatedAt: FIXTURE.timestamp });
    await db.settings.bulkPut([
      { key: "relay_url", value: FIXTURE.relayUrl },
      { key: "active_device", value: deviceId },
      { key: `active_endpoint:${deviceId}`, value: FIXTURE.endpointId },
    ]);
  });
}

function composerReady(): boolean {
  const input = document.querySelector<HTMLTextAreaElement>(".pwa-composer textarea");
  const attachment = document.querySelector<HTMLButtonElement>('[aria-label="Add attachments"]');
  const state = transportSnapshot();
  return Boolean(input && !input.disabled && input.getClientRects().length && attachment && !attachment.disabled
    && state.channelOpen && state.pendingReplies === 0 && state.responseCounts.models_list
    && state.responseCounts.extension_info && state.responseCounts.attachment_capabilities);
}

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function prepareRenderedHistory(): Promise<void> {
  const deadline = performance.now() + PREPARATION_TIMEOUT_MS;
  // 此循环只在 ready 前运行；正式测量没有 observer、轮询或虚拟时钟。
  while (performance.now() < deadline) {
    if (fixtureErrors.length) throw new Error("Fixture preparation reported an error");
    if (renderedHistory() < historyCount) {
      const button = document.querySelector<HTMLButtonElement>(".pwa-earlier button");
      if (button && !button.disabled && button.textContent?.trim() === "Load more") button.click();
    }
    if (renderedHistory() === historyCount && composerReady() && !document.querySelector(".pwa-earlier")) {
      const saved = await api.savedEvents();
      if (saved.length === historyCount) {
        const list = document.querySelector<HTMLElement>(".pwa-message-list");
        if (!list) throw new Error("Missing fixture timeline");
        list.scrollTop = list.scrollHeight;
        list.dispatchEvent(new Event("scroll", { bubbles: true }));
        await pause(500);
        if (fixtureErrors.length || !composerReady() || renderedHistory() !== historyCount) {
          throw new Error("Fixture changed while settling");
        }
        api.ready = true;
        return;
      }
    }
    await pause(40);
  }
  throw new Error("Fixture preparation timed out");
}

async function bootstrap(): Promise<void> {
  historyCount = historyCountFromUrl();
  configureTransport(createHistory(historyCount));
  setLanguagePreference("en");
  applyStoredTextSize();
  const entries = document.querySelectorAll<HTMLMetaElement>('meta[name="pi-reach-default-relay-url"]');
  if (entries.length > 1) throw new Error("Duplicate fixture Relay metadata");
  const metadata = entries[0] ?? document.createElement("meta");
  metadata.name = "pi-reach-default-relay-url";
  metadata.content = FIXTURE.relayUrl;
  if (!metadata.isConnected) document.head.append(metadata);
  await prepareDatabase();
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing fixture PWA root");
  createRoot(root).render(<StrictMode><PwaUiProvider><PwaAppShell runtimeNotice={null}><PwaApp /></PwaAppShell></PwaUiProvider></StrictMode>);
  await prepareRenderedHistory();
}

void bootstrap().catch((error: unknown) => fail(error instanceof Error ? error.message : "Fixture bootstrap failed"));
