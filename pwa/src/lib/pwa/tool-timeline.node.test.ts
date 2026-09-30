import { expect, test } from "vitest";
import { encodeServerFrameV2 as encodeExtensionFrame, type ServerFrame as ExtensionFrame } from "../../../../pi-extension/src/protocol/v2/index";
import { toolPartial, toolTimelineEvent } from "../../../../pi-extension/src/timeline/tool_lifecycle";
import { decodeServerFrameV2 } from "../pi-reach/protocol-v2/codec";
import { TimelineRuntime, type TimelineScope } from "./timeline-runtime";
import { StreamDisplayBuffer } from "./stream-display-buffer";

const scope: TimelineScope = { deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime", sessionId: "session", leafId: "generation", selfSenderRef: "self", channelId: "channel" };
const association = { groupId: "group", tool: "read", args: { path: "README.md" }, correlation: null };

// 使用生产 Extension 构造器和两端 codec，避免模拟器把错误帧掩盖成可用数据。
test.each([false, true])("Extension tool snapshots reach PWA and settle independently (error=%s)", (fail) => {
  const runtime = new TimelineRuntime();
  runtime.setScope(scope);
  const buffer = new StreamDisplayBuffer();
  const receive = (frame: ExtensionFrame) => buffer.ingest(runtime.receive(decodeServerFrameV2(encodeExtensionFrame(frame))).items);
  receive(toolPartial("call-a", association, scope)!);
  receive(toolPartial("call-b", association, scope)!);
  for (const text of ["first", "first second", ""]) {
    const change = receive(toolPartial("call-a", association, scope, { content: [{ type: "text", text }] })!);
    const partials = change.items.filter((item) => item.kind === "partial");
    expect(partials).toHaveLength(2);
    expect(partials.find((item) => item.partial.kind === "tool" && item.partial.tool_call_id === "call-a")?.partial.blocks).toEqual([{ type: "text", text }]);
    expect(change.hasPending).toBe(false);
  }
  const event = {
    ...toolTimelineEvent(
      { event_id: "event-a", session_id: scope.sessionId, leaf_id: scope.leafId, timestamp: 2 },
      association.groupId,
      { toolCallId: "call-a", toolName: "read", content: [{ type: "text", text: fail ? "read failed" : "final output" }], isError: fail },
      association,
    ),
    event_seq: 2,
  };
  const settled = receive({ protocol_version: 2, type: "timeline_event", session_id: scope.sessionId, leaf_id: scope.leafId, event });
  expect(settled.items.filter((item) => item.kind === "partial")).toEqual([
    expect.objectContaining({ partial: expect.objectContaining({ tool_call_id: "call-b" }) }),
  ]);
  expect(settled.items).toContainEqual({ kind: "event", event });
});

test("large live output stays decodable and images never become preview text", () => {
  const partial = toolPartial("large", association, scope, {
    content: [{ type: "text", text: "😀".repeat(100_000) }, { type: "image", data: "image-payload", mimeType: "image/png" }],
  });
  expect(partial).not.toBeNull();
  const frame = decodeServerFrameV2(encodeExtensionFrame(partial!));
  expect(frame.type).toBe("timeline_partial");
  if (frame.type !== "timeline_partial") throw new Error("Expected a tool preview");
  const text = frame.blocks?.map((block) => block.text).join("") ?? "";
  expect(text).toContain("Live preview truncated");
  expect(text).not.toContain("image-payload");
  expect(text).not.toContain("\uFFFD");
});

test("oversized live arguments do not prevent the running indicator", () => {
  const partial = toolPartial("large-args", { ...association, args: { content: "x".repeat(2 * 1024 * 1024) } }, scope);
  expect(partial).not.toBeNull();
  expect(partial).not.toHaveProperty("args");
  expect(decodeServerFrameV2(encodeExtensionFrame(partial!))).toMatchObject({ kind: "tool", status: "running" });
});
