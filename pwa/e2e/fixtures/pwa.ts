import { expect, test as base, type Page } from "playwright/test";

const DATABASE_NAME = "pi-reach";
// Dexie schema v11 对应原生 IndexedDB version 110。
const DATABASE_VERSION = 110;
const FIXTURE_RELAY_URL = "http://127.0.0.1:9";
const FIXTURE_DEVICE_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const FIXTURE_ENDPOINT_ID = "e2e-old-process";
const FIXTURE_DEVICE_NAME = "E2E Pi";
const FIXTURE_HISTORY_PREVIEW = "Saved E2E conversation";

type FixtureDevice = {
  id: string;
  deviceId: string;
  relayUrl: string;
  pairedAt: string;
  hostname: string;
  nickname: string;
};

type FixtureEndpoint = {
  id: string;
  deviceId: string;
  endpointId: string;
  runtimeInstanceId: string;
  kind: "interactive";
  name: string;
  cwd: string;
  updatedAt: number;
};

type FixtureTimelineRecord = {
  id: string;
  deviceId: string;
  endpointId: string;
  sessionId: string;
  leafId: string | null;
  eventId: string;
  eventSeq: number;
  hasPreview: number;
  groupId: string;
  timestamp: number;
  event: {
    event_id: string;
    event_seq: number;
    session_id: string;
    leaf_id: string;
    group_id: string;
    timestamp: number;
    kind: "user";
    message_id: string;
    blocks: Array<{ type: "text"; text: string }>;
    origin: "extension";
    delivery: "normal";
    status: "committed";
  };
};

type FixtureSetting = { key: string; value: string };
export type SeededWorkspace = { deviceId: string; deviceRecordId: string; historyPreview: string };
type PwaFixture = { open: () => Promise<void>; seedWorkspace: () => Promise<SeededWorkspace> };

function fixtureWorkspace(): {
  device: FixtureDevice;
  endpoint: FixtureEndpoint;
  timeline: FixtureTimelineRecord;
  session: {
    id: string;
    deviceId: string;
    endpointId: string;
    sessionId: string;
    leafId: string;
    startedAt: number;
    updatedAt: number;
    eventCount: number;
    preview: string;
  };
  settings: FixtureSetting[];
  seeded: SeededWorkspace;
} {
  const deviceRecordId = encodeURIComponent(FIXTURE_DEVICE_ID);
  const endpointRecordId = `${deviceRecordId}:${encodeURIComponent(FIXTURE_ENDPOINT_ID)}`;
  const sessionId = "e2e-saved-session";
  const leafId = "e2e-saved-leaf";
  const eventId = "e2e-saved-event";
  const timestamp = Date.parse("2026-01-01T00:00:00.000Z");
  const device: FixtureDevice = {
    id: deviceRecordId,
    deviceId: FIXTURE_DEVICE_ID,
    relayUrl: FIXTURE_RELAY_URL,
    pairedAt: "2026-01-01T00:00:00.000Z",
    hostname: FIXTURE_DEVICE_NAME,
    nickname: FIXTURE_DEVICE_NAME,
  };
  const endpoint: FixtureEndpoint = {
    id: endpointRecordId,
    deviceId: FIXTURE_DEVICE_ID,
    endpointId: FIXTURE_ENDPOINT_ID,
    runtimeInstanceId: "e2e-old-runtime",
    kind: "interactive",
    name: "Stale cached Pi",
    cwd: "/workspace/e2e",
    updatedAt: 1,
  };
  const timeline: FixtureTimelineRecord = {
    id: `${deviceRecordId}:${encodeURIComponent(FIXTURE_ENDPOINT_ID)}:${sessionId}:${eventId}`,
    deviceId: FIXTURE_DEVICE_ID,
    endpointId: FIXTURE_ENDPOINT_ID,
    sessionId,
    leafId,
    eventId,
    eventSeq: 1,
    hasPreview: 1,
    groupId: "e2e-saved-group",
    timestamp,
    event: {
      event_id: eventId,
      event_seq: 1,
      session_id: sessionId,
      leaf_id: leafId,
      group_id: "e2e-saved-group",
      timestamp,
      kind: "user",
      message_id: "e2e-saved-message",
      blocks: [{ type: "text", text: FIXTURE_HISTORY_PREVIEW }],
      origin: "extension",
      delivery: "normal",
      status: "committed",
    },
  };

  const session = {
    id: `${deviceRecordId}:${encodeURIComponent(FIXTURE_ENDPOINT_ID)}:${sessionId}`,
    deviceId: FIXTURE_DEVICE_ID,
    endpointId: FIXTURE_ENDPOINT_ID,
    sessionId,
    leafId,
    startedAt: timestamp,
    updatedAt: timestamp,
    eventCount: 1,
    preview: FIXTURE_HISTORY_PREVIEW,
    previewEventId: eventId,
    firstEventId: eventId,
    lastEventId: eventId,
  };

  return {
    device,
    endpoint,
    timeline,
    session,
    settings: [
      { key: "relay_url", value: FIXTURE_RELAY_URL },
      { key: "active_device", value: deviceRecordId },
      { key: `active_endpoint:${deviceRecordId}`, value: FIXTURE_ENDPOINT_ID },
    ],
    seeded: { deviceId: FIXTURE_DEVICE_ID, deviceRecordId, historyPreview: FIXTURE_HISTORY_PREVIEW },
  };
}

function assertLocalTestOrigin(baseURL: string | undefined, pageURL: string) {
  const hostname = new URL(baseURL ?? pageURL).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    throw new Error(`Refusing to write E2E IndexedDB outside localhost: ${hostname}`);
  }
}

async function openPwa(page: Page) {
  await page.goto("/app");
  // 按结构等待空工作区出现，不依赖界面语言。
  await expect(page.locator(".pwa-workspace-state h2")).toBeVisible();
}

export const test = base.extend<{ pwa: PwaFixture }>({
  pwa: async ({ baseURL, page }, provide) => {
    await provide({
      open: () => openPwa(page),
      seedWorkspace: async () => {
        await openPwa(page);
        assertLocalTestOrigin(baseURL, page.url());
        const workspace = fixtureWorkspace();

        await page.evaluate(async ({ databaseName, databaseVersion, device, endpoint, timeline, session, settings }) => {
          const hostname = window.location.hostname;
          if (hostname !== "127.0.0.1" && hostname !== "localhost") {
            throw new Error(`Refusing to write E2E IndexedDB outside localhost: ${hostname}`);
          }
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(databaseName);
            request.onerror = () => reject(request.error ?? new Error("Could not open the PWA database."));
            request.onsuccess = () => resolve(request.result);
          });
          if (database.version !== databaseVersion) {
            database.close();
            throw new Error(`Expected PWA IndexedDB version ${databaseVersion}, received version ${database.version}.`);
          }
          const requiredStores = ["devices", "endpoints", "events", "sessions", "settings"];
          if (requiredStores.some((store) => !database.objectStoreNames.contains(store))) {
            database.close();
            throw new Error(`Expected PWA workspace stores, received ${Array.from(database.objectStoreNames).join(", ")}.`);
          }
          const timelineIndexes = Array.from(database.transaction("events", "readonly").objectStore("events").indexNames);
          const requiredTimelineIndexes = [
            "deviceId",
            "[deviceId+endpointId+sessionId]",
            "[deviceId+endpointId+sessionId+eventSeq]",
            "[deviceId+endpointId+sessionId+timestamp+eventId]",
            "[deviceId+endpointId+sessionId+hasPreview+timestamp+eventId]",
            "[deviceId+timestamp]",
          ];
          if (requiredTimelineIndexes.some((index) => !timelineIndexes.includes(index))) {
            database.close();
            throw new Error(`Expected PWA timeline indexes, received ${timelineIndexes.join(", ")}.`);
          }

          await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction(["devices", "endpoints", "events", "sessions", "settings"], "readwrite");
            transaction.objectStore("devices").put(device);
            transaction.objectStore("endpoints").put(endpoint);
            transaction.objectStore("events").put(timeline);
            transaction.objectStore("sessions").put(session);
            for (const setting of settings) transaction.objectStore("settings").put(setting);
            transaction.oncomplete = () => { database.close(); resolve(); };
            transaction.onerror = () => reject(transaction.error ?? new Error("Could not seed the PWA workspace."));
            transaction.onabort = () => reject(transaction.error ?? new Error("PWA workspace seed was aborted."));
          });
        }, {
          databaseName: DATABASE_NAME,
          databaseVersion: DATABASE_VERSION,
          device: workspace.device,
          endpoint: workspace.endpoint,
          timeline: workspace.timeline,
          session: workspace.session,
          settings: workspace.settings,
        });

        await page.reload();
        // Relay 不可达时停在「正在查找 Pi」加载态（骨架屏），按结构等待。
        await expect(page.locator(".pwa-main [aria-busy='true']")).toBeAttached();
        return workspace.seeded;
      },
    });
  },
});

export { expect };
