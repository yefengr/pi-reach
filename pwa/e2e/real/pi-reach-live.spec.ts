import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page, type TestInfo } from "playwright/test";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const COMPOSE_FILE = "docker/e2e/compose.yml";
const COMPOSE_PROJECT = "pi-reach-e2e";
const CONTROL_BASE_URL = "http://127.0.0.1:18787";
const RELAY_URL = "http://127.0.0.1:18786";
const CONTROL_CAPABILITY_PATH = "/home/pi/.pi/pi-reach/e2e-control-capability";

type HostState = {
  ready?: boolean;
  relay?: string;
  sessionId?: string | null;
};

type PersistenceSnapshot = {
  ownerPublicKeyDigest: string;
  devicesDigest: string;
  deviceCount: number;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runCompose(arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "-p", COMPOSE_PROJECT, "-f", COMPOSE_FILE, ...arguments_], {
      cwd: REPOSITORY_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-64 * 1024); });
    child.stderr.on("data", () => undefined);
    child.once("error", () => reject(new Error(`Could not start docker compose ${arguments_[0] ?? "command"}.`)));
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`docker compose ${arguments_[0] ?? "command"} exited with code ${String(code)}.`));
    });
  });
}

async function readControlCapability(): Promise<string> {
  const capability = (await runCompose(["exec", "-T", "interactive", "cat", CONTROL_CAPABILITY_PATH])).trim();
  if (!capability) throw new Error("Interactive control capability is unavailable.");
  return capability;
}

async function controlFetch(path: string, capability: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${CONTROL_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      "content-type": "application/json",
      "x-e2e-control-capability": capability,
    },
  });
}

async function generatePairingCode(capability: string, previousCode: string | null): Promise<string> {
  const controlResponse = await controlFetch("/control", capability, {
    method: "POST",
    body: JSON.stringify({ action: "pair", request_id: crypto.randomUUID() }),
  });
  if (!controlResponse.ok) throw new Error(`Interactive pairing control returned HTTP ${controlResponse.status}.`);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await controlFetch("/private/pairing", capability);
    if (response.ok) {
      const payload = await response.json() as { ok?: boolean; token?: unknown };
      if (payload.ok === true && typeof payload.token === "string" && payload.token && payload.token !== previousCode) {
        return payload.token;
      }
    } else if (response.status !== 409) {
      throw new Error(`Interactive pairing state returned HTTP ${response.status}.`);
    }
    await delay(150);
  }
  throw new Error("Timed out waiting for a fresh interactive pairing code.");
}

async function readHostState(): Promise<HostState> {
  const response = await fetch(`${CONTROL_BASE_URL}/state`);
  if (!response.ok) throw new Error(`Interactive state returned HTTP ${response.status}.`);
  return response.json() as Promise<HostState>;
}

async function waitForHostState(
  label: string,
  predicate: (state: HostState) => boolean,
  timeout = 60_000,
): Promise<HostState> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const state = await readHostState();
      if (predicate(state)) return state;
    } catch {
      // Relay restarts can briefly make the local control request unavailable.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for interactive ${label}.`);
}

async function configureRelay(page: Page): Promise<void> {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "No computers paired yet" })).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByRole("main", { name: "Settings" });
  await expect(settings).toBeVisible();
  await settings.getByRole("textbox", { name: "Relay URL" }).fill(RELAY_URL);
  await settings.getByRole("button", { name: "Save settings" }).click();
  await settings.getByRole("button", { name: "Back to workspace" }).click();
  await expect(settings).toHaveCount(0);
}

async function expectLiveVersions(page: Page): Promise<void> {
  const packageVersion = (path: string) => (JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { version: string }).version;
  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByRole("main", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect(settings.locator('[data-version="pwa"]')).toHaveText(packageVersion("../../package.json"));
  await expect(settings.locator('[data-version="relay"]')).toHaveText(packageVersion("../../../relay/package.json"));
  await expect(settings.locator('[data-version="extension"]')).toHaveText(packageVersion("../../../pi-extension/package.json"));
  await settings.getByRole("button", { name: "Back to workspace" }).click();
  await expect(settings).toHaveCount(0);
}

async function pairOwner(page: Page, pairingCode: string): Promise<void> {
  await page.getByRole("button", { name: "Start pairing", exact: true }).click();
  const pairingDialog = page.getByRole("dialog", { name: "Pair a computer" });
  await expect(pairingDialog).toBeVisible();
  // 输满 8 位有效字符后自动提交。
  await pairingDialog.getByRole("textbox", { name: "Pairing code" }).fill(pairingCode);
  await expect(pairingDialog).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByLabel("Connected", { exact: true })).toBeVisible({ timeout: 30_000 });
}

async function readPersistenceSnapshot(page: Page): Promise<PersistenceSnapshot> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("pi-reach");
      request.onerror = () => reject(request.error ?? new Error("Could not open the PWA database."));
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const transaction = database.transaction(["identities", "devices"], "readonly");
      const ownerRequest = transaction.objectStore("identities").get("owner");
      const devicesRequest = transaction.objectStore("devices").getAll();
      const owner = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
        ownerRequest.onerror = () => reject(ownerRequest.error ?? new Error("Could not read the Owner identity."));
        ownerRequest.onsuccess = () => resolve(ownerRequest.result as Record<string, unknown> | undefined);
      });
      const devices = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        devicesRequest.onerror = () => reject(devicesRequest.error ?? new Error("Could not read paired devices."));
        devicesRequest.onsuccess = () => resolve(devicesRequest.result as Array<Record<string, unknown>>);
      });
      if (!owner || typeof owner.publicKey !== "string" || owner.publicKey.length === 0) {
        throw new Error("Stored Owner public key is unavailable.");
      }

      const canonicalize = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(canonicalize);
        if (value && typeof value === "object") {
          return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, canonicalize(entry)]));
        }
        return value;
      };
      const digest = async (value: unknown): Promise<string> => {
        const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
        const result = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
      };
      const sortedDevices = devices.sort((left, right) => String(left.id).localeCompare(String(right.id)));
      return {
        ownerPublicKeyDigest: await digest(owner.publicKey),
        devicesDigest: await digest(sortedDevices),
        deviceCount: sortedDevices.length,
      };
    } finally {
      database.close();
    }
  });
}

async function attachFailureScreenshot(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  try {
    await page.screenshot({
      path,
      fullPage: true,
      mask: [page.getByRole("textbox", { name: "Pairing code" })],
      maskColor: "#000000",
    });
    await testInfo.attach(`${name}-screenshot`, { path, contentType: "image/png" });
  } catch {
    // Preserve the original test failure if the page closed during diagnostics.
  }
}

async function attachTrace(context: BrowserContext, name: string, testInfo: TestInfo): Promise<void> {
  const path = testInfo.outputPath(`${name}.zip`);
  await context.tracing.stop({ path });
  await testInfo.attach(`${name}-trace`, { path, contentType: "application/zip" });
}

test("pairs two browser Owners and preserves recovery state across Relay restart and reload", async ({ browser, baseURL }, testInfo) => {
  if (!baseURL) throw new Error("Remote Playwright baseURL is required.");

  const ownerAContext = await browser.newContext({ baseURL, serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  const ownerBContext = await browser.newContext({ baseURL, serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  const ownerAPage = await ownerAContext.newPage();
  const ownerBPage = await ownerBContext.newPage();
  let tracingStarted = false;

  try {
    await waitForHostState("readiness", (state) => state.ready === true, 120_000);
    await Promise.all([configureRelay(ownerAPage), configureRelay(ownerBPage)]);

    const capability = await readControlCapability();
    const firstPairingCode = await generatePairingCode(capability, null);
    await pairOwner(ownerAPage, firstPairingCode);
    const secondPairingCode = await generatePairingCode(capability, firstPairingCode);
    await pairOwner(ownerBPage, secondPairingCode);
    await Promise.all([expectLiveVersions(ownerAPage), expectLiveVersions(ownerBPage)]);

    const beforeReloadA = await readPersistenceSnapshot(ownerAPage);
    const beforeReloadB = await readPersistenceSnapshot(ownerBPage);
    expect(beforeReloadA.deviceCount).toBe(1);
    expect(beforeReloadB.deviceCount).toBe(1);
    expect(beforeReloadA.ownerPublicKeyDigest).not.toBe(beforeReloadB.ownerPublicKeyDigest);

    await Promise.all([
      ownerAContext.tracing.start({ screenshots: true, snapshots: true, sources: true }),
      ownerBContext.tracing.start({ screenshots: true, snapshots: true, sources: true }),
    ]);
    tracingStarted = true;

    const beforeSession = await waitForHostState("session identity", (state) => typeof state.sessionId === "string" && state.sessionId.length > 0);
    await ownerAPage.getByRole("button", { name: "Session actions" }).click();
    await ownerAPage.getByRole("menuitem", { name: "New session", exact: true }).click();
    await expect(ownerAPage.getByRole("dialog", { name: "Start a fresh session?" })).toBeVisible();
    await ownerAPage.getByRole("button", { name: "Start fresh session", exact: true }).click();
    const afterSession = await waitForHostState(
      "fresh session identity",
      (state) => typeof state.sessionId === "string" && state.sessionId.length > 0 && state.sessionId !== beforeSession.sessionId,
    );
    expect(afterSession.sessionId).not.toBe(beforeSession.sessionId);
    await Promise.all([
      expect(ownerAPage.getByLabel("Connected", { exact: true })).toBeVisible(),
      expect(ownerBPage.getByLabel("Connected", { exact: true })).toBeVisible(),
    ]);

    const ownerADisconnected = ownerAPage.getByLabel("Connected", { exact: true }).waitFor({ state: "detached", timeout: 30_000 });
    const ownerBDisconnected = ownerBPage.getByLabel("Connected", { exact: true }).waitFor({ state: "detached", timeout: 30_000 });
    const hostDisconnected = waitForHostState("Relay disconnect", (state) => state.ready !== true, 30_000);
    await Promise.all([runCompose(["restart", "relay"]), ownerADisconnected, ownerBDisconnected, hostDisconnected]);

    await waitForHostState("Relay reconnection", (state) => state.ready === true && state.relay === "connected", 60_000);
    await Promise.all([
      expect(ownerAPage.getByLabel("Connected", { exact: true })).toBeVisible({ timeout: 60_000 }),
      expect(ownerBPage.getByLabel("Connected", { exact: true })).toBeVisible({ timeout: 60_000 }),
    ]);

    await Promise.all([
      ownerAPage.reload({ waitUntil: "domcontentloaded" }),
      ownerBPage.reload({ waitUntil: "domcontentloaded" }),
    ]);
    await Promise.all([
      expect(ownerAPage.getByLabel("Connected", { exact: true })).toBeVisible({ timeout: 60_000 }),
      expect(ownerBPage.getByLabel("Connected", { exact: true })).toBeVisible({ timeout: 60_000 }),
    ]);

    await Promise.all([expectLiveVersions(ownerAPage), expectLiveVersions(ownerBPage)]);
    const afterReloadA = await readPersistenceSnapshot(ownerAPage);
    const afterReloadB = await readPersistenceSnapshot(ownerBPage);
    expect(afterReloadA).toEqual(beforeReloadA);
    expect(afterReloadB).toEqual(beforeReloadB);
  } catch (error) {
    await Promise.all([
      attachFailureScreenshot(ownerAPage, "owner-a-failure", testInfo),
      attachFailureScreenshot(ownerBPage, "owner-b-failure", testInfo),
    ]);
    if (tracingStarted) {
      const results = await Promise.allSettled([
        attachTrace(ownerAContext, "owner-a-trace", testInfo),
        attachTrace(ownerBContext, "owner-b-trace", testInfo),
      ]);
      tracingStarted = false;
      void results;
    }
    throw error;
  } finally {
    if (tracingStarted) {
      await Promise.allSettled([ownerAContext.tracing.stop(), ownerBContext.tracing.stop()]);
    }
    await Promise.allSettled([ownerAContext.close(), ownerBContext.close()]);
  }
});
