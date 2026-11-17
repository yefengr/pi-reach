import { expect, test } from "vitest";
import { getOnlinePiStatus, sortOnlinePis } from "./online-pi-state";
import type { PwaEndpointRecord } from "@/lib/pwa/db";

function endpoint(overrides: Partial<PwaEndpointRecord> = {}): PwaEndpointRecord {
  return {
    id: "endpoint-alpha",
    deviceId: "device",
    endpointId: "alpha",
    runtimeInstanceId: "runtime-alpha",
    kind: "interactive",
    name: "Alpha Pi",
    cwd: "/workspace/alpha",
    online: true,
    updatedAt: 1,
    ...overrides,
  };
}

test("sorts completed-unviewed first, then running, then the rest", () => {
  const endpoints = [
    endpoint({ id: "endpoint-zulu", endpointId: "zulu", name: "Zulu Pi" }),
    endpoint({ id: "endpoint-bravo", endpointId: "bravo", name: "Bravo Pi", working: true }),
    endpoint({ id: "endpoint-finished", endpointId: "finished", name: "Finished Pi" }),
  ];

  expect(sortOnlinePis(endpoints, new Set(["finished"])).map((item) => item.endpointId))
    .toEqual(["finished", "bravo", "zulu"]);
});

test("keeps a running Pi in the running tier even while an old reminder still exists", () => {
  const running = endpoint({ working: true });
  const idle = endpoint({ id: "endpoint-idle", endpointId: "idle", name: "Idle Pi", working: false });
  const completed = new Set(["alpha"]);

  expect(getOnlinePiStatus(running, false, true)).toBe("running");
  expect(sortOnlinePis([running, idle], completed).map((item) => item.endpointId)).toEqual(["alpha", "idle"]);
  // 本轮运行结束后旧提醒恢复为完成档，提醒数据未被运行清除。
  expect(getOnlinePiStatus(running, false, true)).toBe("running");
  expect(getOnlinePiStatus({ ...running, working: false }, false, true)).toBe("completed");
  expect(sortOnlinePis([{ ...running, working: false }, idle], completed).map((item) => item.endpointId)).toEqual(["alpha", "idle"]);
});

test("suppresses the completed tier for the current online session without mutating notices", () => {
  const completed = new Set(["current", "finished"]);
  const endpoints = [
    endpoint({ id: "endpoint-current", endpointId: "current", name: "Current Pi" }),
    endpoint({ id: "endpoint-finished", endpointId: "finished", name: "Finished Pi" }),
    endpoint({ id: "endpoint-running", endpointId: "running", name: "Running Pi", working: true }),
  ];

  expect(sortOnlinePis(endpoints, completed, "current").map((item) => item.endpointId))
    .toEqual(["finished", "running", "current"]);
  expect(getOnlinePiStatus(endpoints[0], true, completed.has("current"))).toBe("idle");
  expect(completed).toEqual(new Set(["current", "finished"]));
});

test("orders each tier by displayed name and uses id as a stable same-name tie break", () => {
  const endpoints = [
    endpoint({ id: "endpoint-b", endpointId: "b", name: "Beta Pi" }),
    endpoint({ id: "endpoint-a2", endpointId: "a2", name: "  Alpha Pi  " }),
    endpoint({ id: "endpoint-a1", endpointId: "a1", name: "Alpha Pi" }),
    endpoint({ id: "endpoint-untitled-2", endpointId: "untitled-2", name: "   " }),
    endpoint({ id: "endpoint-untitled-1", endpointId: "untitled-1", name: undefined }),
  ];

  expect(sortOnlinePis(endpoints).map((item) => item.endpointId))
    .toEqual(["a1", "a2", "b", "untitled-1", "untitled-2"]);
});

test("ignores updatedAt when ordering rows", () => {
  const endpoints = [
    endpoint({ id: "endpoint-alpha", endpointId: "alpha", name: "Alpha Pi", updatedAt: 99 }),
    endpoint({ id: "endpoint-bravo", endpointId: "bravo", name: "Bravo Pi", updatedAt: 1 }),
  ];

  expect(sortOnlinePis(endpoints).map((item) => item.endpointId)).toEqual(["alpha", "bravo"]);
  expect(sortOnlinePis(endpoints).map((item) => item.updatedAt)).toEqual([99, 1]);
});

test("does not modify the input array and tolerates omitted notices or current", () => {
  const endpoints = [
    endpoint({ id: "endpoint-bravo", endpointId: "bravo", name: "Bravo Pi" }),
    endpoint({ id: "endpoint-alpha", endpointId: "alpha", name: "Alpha Pi" }),
  ];
  const snapshot = [...endpoints];

  const sorted = sortOnlinePis(endpoints);
  expect(sorted).not.toBe(endpoints);
  expect(sorted.map((item) => item.endpointId)).toEqual(["alpha", "bravo"]);
  expect(endpoints).toEqual(snapshot);
  expect(sortOnlinePis(endpoints, new Set(["bravo"]), null).map((item) => item.endpointId)).toEqual(["bravo", "alpha"]);
});
