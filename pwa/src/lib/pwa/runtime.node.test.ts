import { expect, test } from "vitest";
import { acceptEndpointRuntime, mergeEndpoints, migrateLegacyDefaultRelay } from "./runtime";

const LEGACY_RELAYS = ["https://relay-pi.yefengr.cn"];
const CURRENT_RELAY = "https://pi-reach-relay.yefengr.cn";
const endpoint = { id: "device:endpoint", deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime-old", kind: "interactive" as const, online: false, model: "old", updatedAt: 1 };

test("keeps the preferred endpoint runtime over a cached endpoint", () => {
  const cached = [endpoint];
  const current = [{ ...endpoint, runtimeInstanceId: "runtime-current", online: true, model: "new", updatedAt: 2 }];
  expect(mergeEndpoints(cached, current)).toEqual(current);
});

test("migrates only missing or legacy default Relay URLs", () => {
  expect(migrateLegacyDefaultRelay(undefined, LEGACY_RELAYS, CURRENT_RELAY)).toBe(CURRENT_RELAY);
  for (const legacy of LEGACY_RELAYS) expect(migrateLegacyDefaultRelay(legacy, LEGACY_RELAYS, CURRENT_RELAY)).toBe(CURRENT_RELAY);
  expect(migrateLegacyDefaultRelay(CURRENT_RELAY, LEGACY_RELAYS, CURRENT_RELAY)).toBe(CURRENT_RELAY);
  expect(migrateLegacyDefaultRelay("https://custom.example.com", LEGACY_RELAYS, CURRENT_RELAY)).toBe("https://custom.example.com");
});

test("uses the deployment default without rewriting explicit production or custom settings", () => {
  const deploymentDefault = "https://staging.example.test/relay/path";
  expect(migrateLegacyDefaultRelay(undefined, LEGACY_RELAYS, deploymentDefault)).toBe(deploymentDefault);
  expect(migrateLegacyDefaultRelay("", LEGACY_RELAYS, deploymentDefault)).toBe(deploymentDefault);
  expect(migrateLegacyDefaultRelay(LEGACY_RELAYS[0], LEGACY_RELAYS, deploymentDefault)).toBe(deploymentDefault);
  expect(migrateLegacyDefaultRelay(CURRENT_RELAY, LEGACY_RELAYS, deploymentDefault)).toBe(CURRENT_RELAY);
  expect(migrateLegacyDefaultRelay("https://custom.example.test/relay", LEGACY_RELAYS, deploymentDefault)).toBe("https://custom.example.test/relay");
});

test("rejects a late event from a runtime that already lost endpoint takeover", () => {
  const history = new Map<string, Set<string>>();
  const oldRuntime = { ...endpoint, runtimeInstanceId: "runtime-old" };
  const newRuntime = { ...oldRuntime, runtimeInstanceId: "runtime-new" };
  expect(acceptEndpointRuntime(history, undefined, oldRuntime)).toBe(true);
  expect(acceptEndpointRuntime(history, oldRuntime, newRuntime)).toBe(true);
  expect(acceptEndpointRuntime(history, oldRuntime, oldRuntime)).toBe(false);
});
