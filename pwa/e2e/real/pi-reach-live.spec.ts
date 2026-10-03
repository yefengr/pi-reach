import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page, type TestInfo } from "playwright/test";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const COMPOSE_FILE = "docker/e2e/compose.yml";
const COMPOSE_PROJECT = "pi-reach-e2e";
const CONTROL_BASE_URL = "http://127.0.0.1:18787";
const RELAY_URL = "http://127.0.0.1:18786";
const CONTROL_CAPABILITY_PATH = "/home/pi/.pi/pi-reach/e2e-control-capability";
const LEGACY_DIST = process.env.PI_REACH_E2E_LEGACY_DIST;

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

async function openLegacyPage(context: BrowserContext): Promise<Page | null> {
  if (!LEGACY_DIST) return null;
  // 同一 origin/context 复用真实 Owner；只替换旧构建资产，不读取或复制身份密钥。
  // 资产拦截不保留浏览器的本地地址空间分类；仅为隔离验收 origin 授予 loopback 访问。
  await context.grantPermissions(["local-network-access"], { origin: new URL(context.pages()[0]!.url()).origin });
  const legacy = await context.newPage();
  await legacy.route("**/app", (route) => route.fulfill({ path: `${LEGACY_DIST}/index.html` }));
  await legacy.route("**/assets/*", (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    if (!/^[a-z0-9._-]+\.(?:js|css)$/i.test(name)) return route.abort();
    return route.fulfill({ path: `${LEGACY_DIST}/assets/${name}` });
  });
  await legacy.goto("/app");
  await expect(legacy.getByLabel("Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
  return legacy;
}

async function startFreshSession(page: Page, previousSessionId: string): Promise<HostState> {
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "New session", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Start a fresh session?" })).toBeVisible();
  await page.getByRole("button", { name: "Start fresh session", exact: true }).click();
  return waitForHostState("fresh session identity", (state) => typeof state.sessionId === "string" && state.sessionId.length > 0 && state.sessionId !== previousSessionId);
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

async function originalDigests(sessionId: string): Promise<Array<{ size: number; sha256: string }>> {
  const script = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    const directory=path.join('/home/pi/.pi/pi-reach/attachments',crypto.createHash('sha256').update(process.argv[1]).digest('hex'));
    const entries=fs.existsSync(directory)?fs.readdirSync(directory).filter(name=>name.endsWith('.bin')):[];
    console.log(JSON.stringify(entries.map(name=>{const bytes=fs.readFileSync(path.join(directory,name));
      return {size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};})));`;
  return JSON.parse(await runCompose(["exec", "-T", "interactive", "node", "-e", script, sessionId])) as Array<{ size: number; sha256: string }>;
}

async function nativeManifestMatches(sessionId: string, expected: Array<{ name: string; size: number; sha256: string }>): Promise<boolean> {
  // 只返回布尔值，不把 Pi 原文、本地路径或配对信息带到测试输出。
  const script = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    const sessionId=process.argv[1],expected=JSON.parse(process.argv[2]);let entries=[];
    function visit(directory){for(const name of fs.readdirSync(directory)){const file=path.join(directory,name);
      if(fs.statSync(file).isDirectory())visit(file);else if(name.endsWith('.jsonl')){
        const records=fs.readFileSync(file,'utf8').split('\\n').filter(Boolean).map(line=>JSON.parse(line));
        if(records[0]?.type==='session'&&records[0].id===sessionId)entries=records;}}}
    visit('/home/pi/.pi/agent/sessions');
    const user=entries.filter(entry=>entry.type==='message'&&entry.message?.role==='user').at(-1)?.message;
    const blocks=typeof user?.content==='string'?[{type:'text',text:user.content}]:user?.content??[];
    const manifest=blocks.filter(block=>block.type==='text').flatMap(block=>block.text.split('\\n')).flatMap(line=>{
      try{const item=JSON.parse(line);return item&&typeof item.path==='string'?[item]:[];}catch{return [];}});
    const directory=path.join('/home/pi/.pi/pi-reach/attachments',crypto.createHash('sha256').update(sessionId).digest('hex'));
    const matches=blocks.every(block=>block.type==='text')&&manifest.length===expected.length&&expected.every(item=>{
      const file=manifest.find(file=>file.file_name===item.name);
      if(!file||file.byte_length!==item.size||path.dirname(file.path)!==directory||!fs.lstatSync(file.path).isFile())return false;
      const bytes=fs.readFileSync(file.path);return bytes.length===item.size&&crypto.createHash('sha256').update(bytes).digest('hex')===item.sha256;});
    console.log(JSON.stringify(matches));`;
  return JSON.parse(await runCompose(["exec", "-T", "interactive", "node", "-e", script, sessionId, JSON.stringify(expected)])) as boolean;
}

async function verifyOriginalUpload(page: Page, otherOwner: Page, sessionId: string): Promise<void> {
  const contents = Buffer.from(Array.from({ length: 130_123 }, (_, index) => index % 251));
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 20;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#2563eb";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }), "base64");
  const originals = [
    { name: "binary-original.bin", mimeType: "application/octet-stream", buffer: contents },
    { name: "empty-original.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
    { name: "image-original.png", mimeType: "image/png", buffer: png },
  ];
  const before = await originalDigests(sessionId);
  await expect(page.getByRole("button", { name: "Add attachments", exact: true })).toBeEnabled();
  // 通用输入与相机分开；选择原件不触发网络上传。
  await page.locator('.pwa-composer input[type="file"]:not([capture])').setInputFiles([
    ...originals,
    { name: "removed-before-send.txt", mimeType: "text/plain", buffer: Buffer.from("not uploaded") },
  ]);
  await page.getByRole("button", { name: "Show all (4)", exact: true }).click();
  await page.getByRole("button", { name: "Remove removed-before-send.txt", exact: true }).click();
  expect(await originalDigests(sessionId)).toEqual(before);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(async () => (await originalDigests(sessionId)).length, { timeout: 60_000 }).toBe(before.length + originals.length);
  const expected = originals.map(({ buffer }) => ({ size: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") }));
  await expect.poll(() => originalDigests(sessionId), { timeout: 60_000 }).toEqual(expect.arrayContaining(expected));
  for (const owner of [page, otherOwner]) {
    await expect(owner.locator('.pwa-message.user').filter({ hasText: "binary-original.bin" }).first()).toBeVisible({ timeout: 60_000 });
    await expect(owner.locator('.pwa-message.user:not(.pending) .pwa-attachment-card')).toHaveCount(originals.length);
    await expect(owner.locator('.pwa-message.user:not(.pending) img[alt="image-original.png"]')).toBeVisible();
    expect(await owner.locator('.pwa-message.user').allTextContents()).not.toEqual(expect.arrayContaining([expect.stringContaining('/home/pi')]));
  }
  await expect.poll(() => nativeManifestMatches(sessionId, expected.map((item, index) => ({ ...item, name: originals[index]!.name }))), { timeout: 60_000 }).toBe(true);
  // 本地确定性 provider 只驱动真实 Pi 生命周期，不调用模型或验证理解与推理。
  await Promise.all([page.reload({ waitUntil: "domcontentloaded" }), otherOwner.reload({ waitUntil: "domcontentloaded" })]);
  for (const owner of [page, otherOwner]) {
    await expect(owner.getByLabel("Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(owner.locator('.pwa-message.user:not(.pending) .pwa-attachment-card')).toHaveCount(originals.length, { timeout: 60_000 });
    await expect(owner.locator('.pwa-message.user:not(.pending) img[alt="image-original.png"]')).toBeVisible();
    expect(await owner.locator('.pwa-message.user').allTextContents()).not.toEqual(expect.arrayContaining([expect.stringContaining('/home/pi')]));
  }
}

test("pairs two browser Owners, uploads exact originals and preserves recovery state across Relay restart and reload", async ({ browser, baseURL }, testInfo) => {
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

    const legacyPage = await openLegacyPage(ownerAContext);
    const beforeSession = await waitForHostState("session identity", (state) => typeof state.sessionId === "string" && state.sessionId.length > 0);
    // 保留 Docker 历史卷，只用产品动作创建独立验收会话，避免旧附件混入计数。
    const attachmentSession = await startFreshSession(ownerAPage, beforeSession.sessionId!);
    for (const owner of [ownerAPage, ownerBPage]) {
      await expect(owner.getByLabel("Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(owner.locator('.pwa-message.user')).toHaveCount(0, { timeout: 60_000 });
    }
    await verifyOriginalUpload(ownerAPage, ownerBPage, attachmentSession.sessionId!);
    if (legacyPage) {
      await expect(legacyPage.getByLabel("Connected", { exact: true })).toBeVisible();
      await expect(legacyPage.locator('.pwa-message.user').filter({ hasText: "binary-original.bin" }).first()).toBeVisible({ timeout: 60_000 });
      expect(await legacyPage.locator('.pwa-message.user').allTextContents()).not.toEqual(expect.arrayContaining([expect.stringContaining('/home/pi')]));
      await legacyPage.reload({ waitUntil: "domcontentloaded" });
      await expect(legacyPage.getByLabel("Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(legacyPage.locator('.pwa-message.user:not(.pending)').filter({ hasText: "binary-original.bin" }).first()).toBeVisible({ timeout: 60_000 });
      await legacyPage.getByRole("textbox").fill("Legacy page text works");
      await legacyPage.getByRole("button", { name: "Send message", exact: true }).click();
      for (const owner of [legacyPage, ownerAPage, ownerBPage]) await expect(owner.locator('.pwa-message.user:not(.pending)').filter({ hasText: "Legacy page text works" }).first()).toBeVisible({ timeout: 60_000 });
    }
    const afterSession = await startFreshSession(ownerAPage, attachmentSession.sessionId!);
    expect(afterSession.sessionId).not.toBe(attachmentSession.sessionId);
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
