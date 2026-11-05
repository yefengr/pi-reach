import { expect, test } from "vitest";
import { BackgroundCompletionNotices, type BackgroundCompletionInput } from "./background-completion-notices";

type Endpoint = BackgroundCompletionInput["endpoints"][number];

function endpoint(working = false, overrides: Partial<Endpoint> = {}): Endpoint {
  return { id: "device-a:pi-a", deviceId: "device-a", endpointId: "pi-a", runtimeInstanceId: "runtime-a", working, online: true, ...overrides };
}

function observer() {
  const notices = new BackgroundCompletionNotices();
  let input: BackgroundCompletionInput = {
    devices: [{ deviceId: "device-a" }, { deviceId: "device-b" }],
    endpoints: [], snapshotDeviceIds: ["device-a", "device-b"], viewingEndpoint: null,
  };
  return (changes: Partial<BackgroundCompletionInput> = {}) => {
    input = { ...input, ...changes };
    return notices.update(input);
  };
}

function completedObserver() {
  const update = observer();
  update({ endpoints: [endpoint(true)] });
  expect([...update({ endpoints: [endpoint()] })]).toEqual(["pi-a"]);
  return update;
}

test("only a previously observed background working-to-idle transition creates a reminder", () => {
  const update = observer();
  expect(update({ endpoints: [endpoint()] }).size).toBe(0);
  expect(update({ endpoints: [endpoint(true)] }).size).toBe(0);
  const completed = update({ endpoints: [endpoint()] });
  expect([...completed]).toEqual(["pi-a"]);
  expect(update()).toBe(completed);
});

test("does not mark the currently viewed live Pi, but still marks another Pi", () => {
  const update = observer();
  const other = { id: "device-a:pi-b", endpointId: "pi-b", runtimeInstanceId: "runtime-b" };
  update({ endpoints: [endpoint(true), endpoint(true, other)], viewingEndpoint: endpoint() });
  expect([...update({ endpoints: [endpoint(), endpoint(false, other)] })]).toEqual(["pi-b"]);
});

test("opening the matching live instance clears its reminder, while history viewing does not", () => {
  const update = completedObserver();
  expect([...update({ viewingEndpoint: null })]).toEqual(["pi-a"]);
  expect(update({ viewingEndpoint: endpoint() }).size).toBe(0);
  expect(update({ viewingEndpoint: null }).size).toBe(0);
});

test("viewing another device or runtime does not acknowledge a reminder", () => {
  const update = completedObserver();
  expect([...update({ viewingEndpoint: endpoint(false, { deviceId: "device-b" }) })]).toEqual(["pi-a"]);
  expect([...update({ viewingEndpoint: endpoint(false, { runtimeInstanceId: "another-runtime" }) })]).toEqual(["pi-a"]);
});

test("starting another run preserves an existing completion reminder", () => {
  const update = completedObserver();
  expect([...update({ endpoints: [endpoint(true)] })]).toEqual(["pi-a"]);
  expect([...update({ endpoints: [endpoint()] })]).toEqual(["pi-a"]);
});

test("a temporary relay disconnect preserves unread completions without retaining online presence", () => {
  const update = completedObserver();
  expect([...update({ endpoints: [], snapshotDeviceIds: [] })]).toEqual(["pi-a"]);
  expect([...update({ endpoints: [endpoint()], snapshotDeviceIds: ["device-a"] })]).toEqual(["pi-a"]);
});

test("the same instance finishing during a disconnect creates a completion on reconnect", () => {
  const update = observer();
  update({ endpoints: [endpoint(true)] });
  expect(update({ endpoints: [], snapshotDeviceIds: [] }).size).toBe(0);
  expect([...update({ endpoints: [endpoint()], snapshotDeviceIds: ["device-a"] })]).toEqual(["pi-a"]);
});

test("reconnecting to an initially idle Pi does not invent an unseen run", () => {
  const update = observer();
  update({ endpoints: [endpoint()] });
  update({ endpoints: [], snapshotDeviceIds: [] });
  expect(update({ endpoints: [endpoint()], snapshotDeviceIds: ["device-a"] }).size).toBe(0);
});

test.each([true, false])("a new runtime inherits neither the old working state nor its reminder (working=%s)", working => {
  const update = working ? observer() : completedObserver();
  if (working) update({ endpoints: [endpoint(true)] });
  update({ endpoints: [], snapshotDeviceIds: [] });
  expect(update({ endpoints: [endpoint(false, { runtimeInstanceId: "runtime-new" })], snapshotDeviceIds: ["device-a"] }).size).toBe(0);
});

test("a live runtime replacement clears the previous instance's reminder", () => {
  const update = completedObserver();
  expect(update({ endpoints: [endpoint(false, { runtimeInstanceId: "runtime-new" })] }).size).toBe(0);
});

test("only the corresponding device's authoritative snapshot can remove a missing Pi", () => {
  const update = completedObserver();
  update({ endpoints: [], snapshotDeviceIds: [] });
  const other = endpoint(false, { id: "device-b:pi-b", deviceId: "device-b", endpointId: "pi-b", runtimeInstanceId: "runtime-b" });
  expect([...update({ endpoints: [other], snapshotDeviceIds: ["device-b"] })]).toEqual(["pi-a"]);
  expect(update({ snapshotDeviceIds: ["device-a", "device-b"] }).size).toBe(0);
  expect(update({ endpoints: [endpoint(), other] }).size).toBe(0);
});

test("confirmed endpoint removal drops both the reminder and the old working state", () => {
  const update = completedObserver();
  expect(update({ endpoints: [] }).size).toBe(0);
  update({ endpoints: [endpoint(true)] });
  update({ endpoints: [] });
  expect(update({ endpoints: [endpoint()] }).size).toBe(0);
});

test("unpairing removes retained reminders even before a new registry snapshot", () => {
  const update = completedObserver();
  update({ endpoints: [], snapshotDeviceIds: [] });
  expect(update({ devices: [{ deviceId: "device-b" }] }).size).toBe(0);
  expect(update({ endpoints: [endpoint()] }).size).toBe(0);
});

test("a new page starts without the previous page's reminders", () => {
  completedObserver();
  expect(observer()({ endpoints: [endpoint()] }).size).toBe(0);
});
