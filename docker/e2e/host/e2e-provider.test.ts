import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// SDK 是 Pi 的运行时依赖而非本仓库依赖；允许显式给出已安装 SDK 入口，不安装或 mock 流 API。
const sdkEntry = process.env.PI_REACH_E2E_PI_AI_ENTRY
  ?? createRequire(import.meta.url).resolve("@earendil-works/pi-ai");
const source = stripTypeScriptTypes(await readFile(new URL("./e2e-provider.ts", import.meta.url), "utf8"))
  .replace('from "@earendil-works/pi-ai"', `from ${JSON.stringify(pathToFileURL(sdkEntry).href)}`);
const { default: register } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
let provider: Parameters<ExtensionAPI["registerProvider"]>[1] | undefined;
register({ registerProvider(_id: string, value: Parameters<ExtensionAPI["registerProvider"]>[1]) { provider = value; } });
assert.ok(provider?.streamSimple);
const streamSimple = provider.streamSimple;
const model = { api: "pi-reach-e2e", provider: "pi-reach-e2e", id: "fixture" };
const trigger = { role: "user", content: [{ type: "text", text: "E2E publish file fixtures" }] };

async function run(messages: unknown[], options = {}) {
  const stream = streamSimple(model as never, { messages } as never, options);
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

test("exact trigger emits three native publish_file calls through the real SDK stream", async () => {
  const { events, message } = await run([trigger]);
  assert.equal(message.stopReason, "toolUse");
  assert.equal(events.filter(event => event.type === "toolcall_end").length, 3);
  assert.deepEqual(message.content.map(block => block.type === "toolCall" && [block.name, block.arguments]), [
    ["publish_file", { path: "/workspace/pi-reach-published-files/report-中文.md" }],
    ["publish_file", { path: "/workspace/pi-reach-published-files/image.png" }],
    ["publish_file", { path: "/workspace/pi-reach-published-files/data.bin" }],
  ]);
  const ids = message.content.flatMap(block => block.type === "toolCall" ? [block.id] : []);
  assert.equal(new Set(ids).size, 3);
  const next = await run([trigger]);
  assert.ok(next.message.content.every(block => block.type === "toolCall" && !ids.includes(block.id)));
});

test("ordinary, near-match, mixed-content and historical trigger messages keep empty stop", async () => {
  for (const messages of [
    [], [{ role: "user", content: "ordinary message" }],
    [{ role: "user", content: "E2E publish file fixtures " }],
    [{ role: "user", content: [...trigger.content, { type: "text", text: "extra" }] }],
    [trigger, { role: "user", content: "ordinary message" }],
  ]) {
    const { message } = await run(messages);
    assert.equal(message.stopReason, "stop");
    assert.deepEqual(message.content, []);
  }
});

test("successful or failed tool results finish without replaying the trigger", async () => {
  for (const isError of [false, true]) {
    const { message } = await run([trigger, { role: "toolResult", toolName: "publish_file", isError, content: [] }]);
    assert.equal(message.stopReason, "stop");
    assert.deepEqual(message.content, []);
  }
});

test("aborted and throwing hooks emit sanitized errors without tool calls", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = await run([trigger], { signal: controller.signal });
  assert.equal(aborted.message.stopReason, "aborted");
  assert.deepEqual(aborted.message.content, []);
  const failed = await run([trigger], { onPayload() { throw new Error("not-for-output"); } });
  assert.equal(failed.message.errorMessage, "E2E fixture failed");
  assert.deepEqual(failed.message.content, []);
});
