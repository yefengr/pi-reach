import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
const streamTrigger = { role: "user", content: [{ type: "text", text: "E2E stream tool fixture" }] };

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

test("exact stream trigger emits one native bash call with a fixed command and fresh id", async () => {
  const ids = new Set<string>();
  for (const content of [streamTrigger.content, "E2E stream tool fixture"]) {
    const { events, message } = await run([{ role: "user", content }]);
    assert.equal(message.stopReason, "toolUse");
    assert.deepEqual(events.map(event => event.type), ["start", "toolcall_start", "toolcall_end", "done"]);
    assert.equal(message.content.length, 1);
    const call = message.content[0];
    assert.equal(call.type, "toolCall");
    if (call.type !== "toolCall") return;
    assert.equal(call.name, "bash");
    assert.deepEqual(call.arguments, { command: [
      "node -e 'console.log(\"E2E stream start\"); let tick = 0;",
      "const timer = setInterval(() => { tick += 1; console.log(\"E2E stream tick \" + tick);",
      "if (tick === 10) { clearInterval(timer); console.log(\"E2E stream complete\"); } }, 1000);'",
    ].join(" ") });
    assert.match(call.id, /^e2e-stream-[\da-f-]+$/);
    assert.ok(!ids.has(call.id));
    ids.add(call.id);
    const finalEvent = events.at(-1);
    assert.equal(finalEvent?.type, "done");
    if (finalEvent?.type === "done") assert.equal(finalEvent.reason, "toolUse");
  }
});

test("fixed bash command produces incremental synthetic output and exits without a mock", { timeout: 30000 }, async () => {
  const { message } = await run([streamTrigger]);
  const call = message.content[0];
  assert.equal(call.type, "toolCall");
  if (call.type !== "toolCall") return;
  assert.equal(typeof call.arguments.command, "string");
  const child = spawn("/bin/bash", ["-c", call.arguments.command as string], { timeout: 25000 });
  const chunks: { text: string; at: number }[] = [];
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => chunks.push({ text, at: performance.now() }));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => { stderr += text; });
  const [code, signal] = await once(child, "close");
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(stderr, "");
  assert.deepEqual(chunks.map(chunk => chunk.text).join("").trimEnd().split("\n"), [
    "E2E stream start",
    ...Array.from({ length: 10 }, (_, index) => `E2E stream tick ${index + 1}`),
    "E2E stream complete",
  ]);
  assert.ok(chunks.length >= 3, "stdout must arrive incrementally");
  assert.ok(chunks[0].text.includes("E2E stream start"));
  assert.ok(!chunks[0].text.includes("E2E stream complete"));
  assert.ok(chunks.at(-1)!.at - chunks[0].at >= 8000, "output must span a slow tool execution");
});

test("ordinary, near-match, mixed-content and historical trigger messages keep empty stop", async () => {
  for (const messages of [
    [], [{ role: "user", content: "ordinary message" }],
    [{ role: "user", content: "E2E publish file fixtures " }],
    [{ role: "user", content: "E2E stream tool fixture " }],
    [{ role: "user", content: "e2e stream tool fixture" }],
    [{ role: "user", content: "prefix E2E stream tool fixture" }],
    [{ role: "user", content: "E2E stream tool fixture\n" }],
    [{ role: "user", content: [...trigger.content, { type: "text", text: "extra" }] }],
    [{ role: "user", content: [...streamTrigger.content, { type: "text", text: "extra" }] }],
    [{ role: "user", content: [...streamTrigger.content, { type: "image", data: "", mimeType: "image/png" }] }],
    [trigger, { role: "user", content: "ordinary message" }],
    [streamTrigger, { role: "user", content: "ordinary message" }],
    [streamTrigger, { role: "assistant", content: [] }],
  ]) {
    const { message } = await run(messages);
    assert.equal(message.stopReason, "stop");
    assert.deepEqual(message.content, []);
  }
});

test("successful or failed tool results finish without replaying the trigger", async () => {
  for (const [input, toolName] of [[trigger, "publish_file"], [streamTrigger, "bash"]] as const) {
    for (const isError of [false, true]) {
      const { events, message } = await run([input, { role: "toolResult", toolName, isError, content: [] }]);
      assert.equal(message.stopReason, "stop");
      assert.deepEqual(message.content, []);
      assert.deepEqual(events.map(event => event.type), ["start", "done"]);
    }
  }
});

test("aborted and throwing hooks emit sanitized errors without tool calls", async () => {
  const controller = new AbortController();
  controller.abort();
  for (const input of [trigger, streamTrigger]) {
    const aborted = await run([input], { signal: controller.signal });
    assert.equal(aborted.message.stopReason, "aborted");
    assert.equal(aborted.message.errorMessage, "E2E fixture aborted");
    assert.deepEqual(aborted.message.content, []);
    assert.deepEqual(aborted.events.map(event => event.type), ["error"]);
    for (const hook of ["onPayload", "onResponse"]) {
      const failed = await run([input], { [hook]() { throw new Error("not-for-output"); } });
      assert.equal(failed.message.stopReason, "error");
      assert.equal(failed.message.errorMessage, "E2E fixture failed");
      assert.deepEqual(failed.message.content, []);
      assert.deepEqual(failed.events.map(event => event.type), ["error"]);
    }
  }
});
