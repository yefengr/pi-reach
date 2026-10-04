import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { expect, type Locator, type Page, type TestInfo } from "playwright/test";

const TRIGGER = "E2E publish file fixtures";
const ROOT = "/workspace/pi-reach-published-files";
type HostState = { ready?: boolean; sessionId?: string | null; endpointId?: string | null; runtimeId?: string | null };
type HostControls = {
  runCompose: (args: readonly string[]) => Promise<string>;
  controlFetch: (path: string, capability: string, init?: RequestInit) => Promise<Response>;
  waitForHostState: (label: string, predicate: (state: HostState) => boolean, timeout?: number) => Promise<HostState>;
};
type Fixture = { name: string; bytes: Buffer; sha256: string };

function fixturePng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 37, 99, 235, 255, 37, 99, 235, 255]))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function fixtures(): Fixture[] {
  return [
    { name: "report-中文.md", bytes: Buffer.from("# Published fixture report\n\n**原名与原件**\n\n| Item | Result |\n| --- | --- |\n| Synthetic | Verified |\n") },
    { name: "image.png", bytes: fixturePng() },
    { name: "data.bin", bytes: Buffer.from(Array.from({ length: 70_123 }, (_, index) => index % 251)) },
  ].map(file => ({ ...file, sha256: createHash("sha256").update(file.bytes).digest("hex") }));
}

async function writeFixtures(host: HostControls, files: Fixture[]): Promise<void> {
  // 精确覆盖这三个合成测试文件；不清空 workspace、会话或旧卷。
  const script = `const fs=require('node:fs'),path=require('node:path');
    const root=process.argv[1],files=JSON.parse(process.argv[2]);fs.mkdirSync(root,{recursive:true});
    for(const file of files)fs.writeFileSync(path.join(root,file.name),Buffer.from(file.base64,'base64'));`;
  await host.runCompose(["exec", "-T", "interactive", "node", "-e", script, ROOT,
    JSON.stringify(files.map(file => ({ name: file.name, base64: file.bytes.toString("base64") })))]);
}

async function nativePublicationsMatch(host: HostControls, sessionId: string, files: Fixture[]): Promise<boolean> {
  // 真实原生磁盘分支必须同时具有 assistant 调用、custom 与成功 toolResult；仅返回布尔值。
  const script = `const fs=require('node:fs'),path=require('node:path');
    const sessionId=process.argv[1],expected=JSON.parse(process.argv[2]);let records=[];
    function visit(dir){for(const name of fs.readdirSync(dir)){const file=path.join(dir,name);
      if(fs.statSync(file).isDirectory())visit(file);else if(name.endsWith('.jsonl')){
        const rows=fs.readFileSync(file,'utf8').split('\\n').filter(Boolean).map(line=>JSON.parse(line));
        if(rows[0]?.type==='session'&&rows[0].id===sessionId)records=rows;}}}
    visit('/home/pi/.pi/agent/sessions');
    const byId=new Map(records.filter(row=>row.id).map(row=>[row.id,row])),branch=[];
    let entry=records.filter(row=>row.type!=='session'&&row.id).at(-1);
    while(entry){branch.unshift(entry);entry=byId.get(entry.parentId);}
    const custom=branch.filter(row=>row.type==='custom'&&row.customType==='pi-reach:published-file-v1');
    const calls=branch.flatMap(row=>row.type==='message'&&row.message?.role==='assistant'?row.message.content??[]:[])
      .filter(block=>block.type==='toolCall'&&block.name==='publish_file');
    const matches=custom.length===expected.length&&calls.length===expected.length&&expected.every(file=>{
      const publication=custom.find(row=>row.data?.file_name===file.name);
      const data=publication?.data;
      if(!data||data.source_path!==file.path||data.byte_length!==file.size)return false;
      const call=calls.find(call=>call.id===data.tool_call_id&&call.arguments?.path===file.path);
      const result=branch.find(row=>row.type==='message'&&row.message?.role==='toolResult'&&
        row.message.toolCallId===data.tool_call_id&&row.message.toolName==='publish_file'&&
        row.message.isError===false&&row.message.details?.publication_id===publication.id);
      return !!call&&!!result&&branch.indexOf(result)>branch.indexOf(publication);});
    console.log(JSON.stringify(matches));`;
  return JSON.parse(await host.runCompose(["exec", "-T", "interactive", "node", "-e", script, sessionId,
    JSON.stringify(files.map(file => ({ name: file.name, path: `${ROOT}/${file.name}`, size: file.bytes.length })))])) as boolean;
}

function card(page: Page, name: string): Locator {
  return page.locator(".pwa-published-file").filter({ has: page.locator(".pwa-published-name", { hasText: name }) });
}

async function saveAndVerify(page: Page, fileCard: Locator, file: Fixture, outputPath: string): Promise<void> {
  const save = fileCard.getByRole("link", { name: "Save file", exact: true });
  if (await save.count() === 0) await fileCard.getByRole("button", { name: "Download", exact: true }).click();
  await expect(save).toBeVisible({ timeout: 60_000 });
  await expect(save).toHaveAttribute("download", file.name);
  // 获取完成不自动保存：独立的新手势才触发浏览器下载。
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await save.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(file.name);
  await download.saveAs(outputPath);
  expect(await download.failure()).toBeNull();
  const bytes = await readFile(outputPath);
  expect(bytes.length).toBe(file.bytes.length);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
}

async function verifyVisuals(page: Page): Promise<void> {
  const directory = fileURLToPath(new URL("../../../.pi/tmp/screenshots/session-files/", import.meta.url));
  await mkdir(directory, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const settings = page.getByRole("main", { name: "Settings", exact: true });
    await settings.getByRole("radio", { name: theme === "light" ? /^Light\b/ : /^Dark\b/ }).check();
    await settings.getByRole("button", { name: "Back to workspace", exact: true }).click();
    for (const [layout, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await card(page, "image.png").scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `${directory}/${layout}-${theme}-files.png`, animations: "disabled" });
      for (const file of ["report-中文.md", "image.png"]) {
        await card(page, file).getByRole("button", { name: file === "image.png" ? "View image" : "View", exact: true }).click();
        const reader = page.getByRole("dialog", { name: file, exact: true });
        await expect(reader).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: `${directory}/${layout}-${theme}-${file === "image.png" ? "image" : "text"}.png`, animations: "disabled" });
        await reader.getByRole("button", { name: "Close file reader", exact: true }).click();
        await expect(reader).toHaveCount(0);
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function verifyOwner(page: Page, files: Fixture[], testInfo: TestInfo, label: string): Promise<string[]> {
  await expect(page.locator(".pwa-published-file")).toHaveCount(files.length, { timeout: 60_000 });
  const ids: string[] = [];
  for (const file of files) {
    const fileCard = card(page, file.name);
    await expect(fileCard).toHaveCount(1);
    await expect(fileCard.locator(".pwa-published-name")).toHaveText(file.name);
    ids.push((await fileCard.getAttribute("data-publication-id"))!);
  }
  // 接近视口的小 PNG 自动完整获取；不先点击获取或下载冒充 auto。
  const image = card(page, "image.png").getByRole("img", { name: "image.png", exact: true });
  await card(page, "image.png").scrollIntoViewIfNeeded();
  await expect(image).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => image.evaluate(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth === 2 && node.naturalHeight === 1)).toBe(true);
  await expect(card(page, "image.png").getByRole("link", { name: "Save file", exact: true })).toBeVisible();

  // 首次 View 点击须在异步获取后直接打开阅读器。
  await card(page, "report-中文.md").getByRole("button", { name: "View", exact: true }).click();
  const reader = page.getByRole("dialog", { name: "report-中文.md", exact: true });
  await expect(reader).toBeVisible({ timeout: 60_000 });
  await expect(reader.getByRole("heading", { name: "Published fixture report", exact: true })).toBeVisible();
  await expect(reader.locator("strong")).toHaveText("原名与原件");
  await expect(reader.getByRole("table")).toBeVisible();
  await reader.getByRole("button", { name: "Close file reader", exact: true }).click();
  await expect(reader).toHaveCount(0);

  await card(page, "image.png").getByRole("button", { name: "View image", exact: true }).click();
  const imageReader = page.getByRole("dialog", { name: "image.png", exact: true });
  await expect(imageReader).toBeVisible();
  await expect(imageReader.getByRole("img", { name: "image.png", exact: true })).toBeVisible();
  await imageReader.getByRole("button", { name: "Close file reader", exact: true }).click();
  await expect(imageReader).toHaveCount(0);
  for (const [index, file] of files.entries()) {
    await saveAndVerify(page, card(page, file.name), file, testInfo.outputPath(`${label}-${index}-${file.name}`));
  }
  if (label === "owner-0-live") await verifyVisuals(page);
  return ids;
}

export async function verifyPublishedFiles(
  owners: readonly [Page, Page], sessionId: string, capability: string, host: HostControls, testInfo: TestInfo,
): Promise<void> {
  const files = fixtures();
  await writeFixtures(host, files);
  await owners[0].getByRole("textbox").fill(TRIGGER);
  await owners[0].getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => nativePublicationsMatch(host, sessionId, files), { timeout: 60_000 }).toBe(true);
  const ownerIds: string[][] = [];
  for (const [index, owner] of owners.entries()) ownerIds.push(await verifyOwner(owner, files, testInfo, `owner-${index}-live`));
  expect(ownerIds[0]).toEqual(ownerIds[1]);

  for (const [index, owner] of owners.entries()) {
    await owner.reload({ waitUntil: "domcontentloaded" });
    await expect(owner.getByLabel("Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(await verifyOwner(owner, files, testInfo, `owner-${index}-reload`)).toEqual(ownerIds[index]);
  }

  const before = await host.waitForHostState("publication runtime identity", state => state.ready === true && !!state.runtimeId && !!state.endpointId);
  const response = await host.controlFetch("/control", capability, {
    method: "POST", body: JSON.stringify({ action: "restart", request_id: crypto.randomUUID() }),
  });
  if (!response.ok) throw new Error(`Interactive restart returned HTTP ${response.status}.`);
  const resumed = await host.waitForHostState("native Pi continuation", state => state.ready === true && !!state.runtimeId && state.runtimeId !== before.runtimeId);
  expect(resumed.sessionId).toBe(sessionId);
  expect(resumed.endpointId).not.toBe(before.endpointId);
  await expect.poll(() => nativePublicationsMatch(host, sessionId, files), { timeout: 60_000 }).toBe(true);
  for (const [index, owner] of owners.entries()) {
    // 清掉 Blob 缓存，显式选择在线 Pi；不按 cwd 绑定旧本地历史。
    await owner.reload({ waitUntil: "domcontentloaded" });
    const onlinePi = owner.locator("#pwa-desktop-navigation .pwa-nav-session");
    await expect(onlinePi).toHaveCount(1, { timeout: 60_000 });
    await onlinePi.click();
    await expect(onlinePi).toHaveAttribute("aria-current", "true");
    await expect(owner.getByLabel("Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(await verifyOwner(owner, files, testInfo, `owner-${index}-native-resume`)).toEqual(ownerIds[index]);
  }
}
