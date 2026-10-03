import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const home = process.env.HOME || "/home/pi";
const workspace = "/workspace";
const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR || `${home}/.pi/agent/sessions`;
const controlCapabilityPath = `${home}/.pi/pi-reach/e2e-control-capability`;
const identityPath = `${home}/.pi/pi-reach/identity.json`;
const controlPort = Number(process.env.INTERACTIVE_CONTROL_PORT || "8787");
let child = null;
let pendingRestart = false;
let closing = false;
let state = {
  running: false,
  rpcReady: false,
  runtimeReady: false,
  relay: "disconnected",
  sessionId: null,
  endpointId: null,
  runtimeId: null,
  deviceId: null,
  pairingToken: null,
  lastError: null,
};
let stdoutBuffer = "";
let stderrTail = "";
let controlCapability;

function safeString(value) {
  return typeof value === "string" ? value.slice(0, 512) : undefined;
}

async function refreshDeviceId() {
  try {
    const identity = JSON.parse(await readFile(identityPath, "utf8"));
    if (typeof identity.pk === "string") state.deviceId = Buffer.from(identity.pk, "base64").toString("base64");
  } catch { /* identity is created asynchronously during extension startup */ }
}

function updateFromLine(line) {
  let value;
  try { value = JSON.parse(line); } catch { return; }
  if (value?.type === "response" && value.command === "get_state" && value.success === true) {
    state.rpcReady = true;
    if (typeof value.data?.sessionId === "string") state.sessionId = value.data.sessionId;
  }
  const entry = value?.type === "entry_appended" ? value.entry : value?.type === "message_start" ? value.message : null;
  const custom = entry?.details && typeof entry.details === "object" ? entry : null;
  const statusDetails = value?.type === "extension_ui_request" && value.method === "setStatus" && value.statusKey === "pi-reach:control" && typeof value.statusText === "string"
    ? (() => { try { return JSON.parse(value.statusText); } catch { return null; } })() : null;
  const runtime = custom?.customType === "pi-reach:runtime-ready" ? custom.details : statusDetails?.type === "runtime_ready" ? statusDetails : null;
  if (runtime && typeof runtime === "object") {
    const discoveredEndpointId = safeString(runtime.endpoint_id);
    const discoveredRuntimeId = safeString(runtime.runtime_instance_id);
    if (runtime.control_protocol_version === 2 && discoveredEndpointId && discoveredRuntimeId) {
      state.runtimeReady = true;
      state.runtimeId = discoveredRuntimeId;
      state.endpointId = discoveredEndpointId;
      state.sessionId = safeString(runtime.session_id) || state.sessionId;
      void refreshDeviceId();
    }
  }
  if (custom?.customType === "pi-reach:session-changed") {
    state.sessionId = safeString(custom.details.session_id) || state.sessionId;
    state.endpointId = safeString(custom.details.endpoint_id) || state.endpointId;
    state.runtimeId = safeString(custom.details.runtime_instance_id) || state.runtimeId;
  }
  if (custom?.customType === "pi-reach:relay-state") {
    state.relay = safeString(custom.details.state) || state.relay;
    state.endpointId = safeString(custom.details.endpoint_id) || state.endpointId;
    state.runtimeId = safeString(custom.details.runtime_instance_id) || state.runtimeId;
  }
  if (value?.type === "extension_ui_request" && value.method === "setWidget" && Array.isArray(value.widgetLines)) {
    const pairingLine = value.widgetLines.find((item) => typeof item === "string" && item.startsWith("Pairing code: "));
    if (pairingLine) state.pairingToken = pairingLine.slice("Pairing code: ".length).trim();
  }
  if (statusDetails?.type === "relay_state") {
    state.relay = safeString(statusDetails.state) || state.relay;
    state.endpointId = safeString(statusDetails.endpoint_id) || state.endpointId;
    state.runtimeId = safeString(statusDetails.runtime_instance_id) || state.runtimeId;
  }
  const direct = entry?.customType === "pi-reach:relay-state" ? entry.details : null;
  if (direct && typeof direct === "object") {
    state.relay = safeString(direct.state) || state.relay;
    state.endpointId = safeString(direct.endpoint_id) || state.endpointId;
    state.runtimeId = safeString(direct.runtime_instance_id) || state.runtimeId;
  }
}

function start() {
  if (closing || child) return;
  state = { ...state, running: true, rpcReady: false, runtimeReady: false, relay: "connecting", endpointId: null, runtimeId: null, lastError: null };
  const nextChild = spawn("pi", ["--mode", "rpc", "--approve", "--continue", "--name", "e2e-interactive", "--extension", "/usr/local/bin/e2e-provider.ts", "--provider", "pi-reach-e2e", "--model", "fixture"], {
    cwd: workspace,
    env: {
      ...process.env,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_REACH_ALLOW_FILE_IDENTITY: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child = nextChild;
  let childStdoutBuffer = "";
  nextChild.stdout.on("data", (chunk) => {
    if (child !== nextChild) return;
    childStdoutBuffer += chunk.toString();
    let index;
    while ((index = childStdoutBuffer.indexOf("\n")) >= 0) {
      if (child !== nextChild) return;
      const line = childStdoutBuffer.slice(0, index);
      childStdoutBuffer = childStdoutBuffer.slice(index + 1);
      if (line.trim()) updateFromLine(line);
    }
  });
  nextChild.stderr.on("data", (chunk) => {
    if (child !== nextChild) return;
    stderrTail = (stderrTail + chunk.toString()).slice(-1024);
  });
  nextChild.once("exit", (code, signal) => {
    if (child !== nextChild) return;
    child = null;
    state = { ...state, running: false, rpcReady: false, runtimeReady: false, relay: "disconnected", lastError: code === 0 ? null : `pi exited (${String(code ?? signal)})` };
    const restart = pendingRestart && !closing;
    pendingRestart = false;
    if (restart) start();
  });
  send({ id: `ready-${randomUUID()}`, type: "get_state" });
}

function send(frame) {
  if (!child?.stdin?.writable) throw new Error("interactive Pi is not running");
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function stop(reason = "shutdown") {
  if (!child) return;
  if (reason === "peer_stop") send({ id: `stop-${randomUUID()}`, type: "prompt", message: "\u0000pi-reach-ctrl:relay:off" });
  else if (reason === "shutdown") child.kill("SIGTERM");
}

async function loadControlCapability() {
  try {
    const value = (await readFile(controlCapabilityPath, "utf8")).trim();
    if (value) {
      await chmod(controlCapabilityPath, 0o600);
      return value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const value = randomBytes(32).toString("base64url");
  await writeFile(controlCapabilityPath, `${value}\n`, { mode: 0o600 });
  await chmod(controlCapabilityPath, 0o600);
  return value;
}

function hasControlCapability(value) {
  if (typeof value !== "string" || !controlCapability) return false;
  const received = Buffer.from(value);
  const expected = Buffer.from(controlCapability);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function response(socket, status, payload) {
  const body = JSON.stringify(payload);
  socket.end(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

function parseRequest(data) {
  const [head, body = ""] = data.split("\r\n\r\n");
  const [method = "", path = ""] = head.split("\r\n")[0]?.split(" ") || [];
  let json = {};
  try { json = body ? JSON.parse(body) : {}; } catch { json = {}; }
  return { method, path, json };
}

await mkdir(`${home}/.pi/pi-reach`, { recursive: true });
controlCapability = await loadControlCapability();
await mkdir(sessionDir, { recursive: true });
await mkdir(`${workspace}/.pi/pi-reach`, { recursive: true });
await writeFile(`${workspace}/.pi/pi-reach/config.json`, JSON.stringify({ agent_name: "e2e-interactive" }));

const handleRequest = (method, path, json, capability) => {
  if (method === "GET" && path === "/health") return [200, { ok: true }];
  if (method === "GET" && path === "/state") {
    const { deviceId: _deviceId, pairingToken: _pairingToken, ...publicState } = state;
    return [200, { ...publicState, ready: state.rpcReady && state.runtimeReady && state.relay === "connected" }];
  }
  if ((method === "GET" && path === "/private/pairing") || method === "POST") {
    if (!hasControlCapability(capability)) return [403, { ok: false }];
  }
  if (method === "GET" && path === "/private/pairing") {
    if (!state.deviceId || !state.pairingToken || !state.runtimeId) return [409, { ok: false }];
    return [200, { ok: true, device_id: state.deviceId, endpoint_id: state.endpointId, runtime_instance_id: state.runtimeId, token: state.pairingToken }];
  }
  if (method === "POST" && path === "/rpc") {
    try { send(json); return [202, { ok: true }]; }
    catch (error) { return [409, { ok: false, error: String(error) }]; }
  }
  if (method === "POST" && path === "/control") {
    const action = json.action;
    if (action === "restart") {
      if (closing) return [409, { ok: false }];
      if (child) {
        pendingRestart = true;
        stop("shutdown");
      } else {
        start();
      }
      return [202, { ok: true }];
    }
    if (action === "pair") {
      try { state.pairingToken = null; send({ id: `pair-${randomUUID()}`, type: "prompt", message: "/pi-reach pair" }); return [202, { ok: true }]; }
      catch (error) { return [409, { ok: false, error: String(error) }]; }
    }
    if (action === "revoke" && typeof json.owner_id === "string") {
      try { send({ id: `revoke-${randomUUID()}`, type: "prompt", message: `/pi-reach revoke ${json.owner_id.slice(0, 8)}` }); return [202, { ok: true }]; }
      catch (error) { return [409, { ok: false, error: String(error) }]; }
    }
    if (action === "peer_stop") { try { stop("peer_stop"); return [202, { ok: true }]; } catch (error) { return [409, { ok: false, error: String(error) }]; } }
    if (action === "shutdown") { stop("shutdown"); return [202, { ok: true }]; }
  }
  return [404, { ok: false }];
};

const httpServer = createServer((request, responseObject) => {
  let data = "";
  request.on("data", (chunk) => { data += chunk.toString(); });
  request.on("end", () => {
    let json = {};
    try { json = data ? JSON.parse(data) : {}; } catch { json = {}; }
    const [status, payload] = handleRequest(request.method || "", request.url || "", json, request.headers["x-e2e-control-capability"]);
    const body = JSON.stringify(payload);
    responseObject.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    responseObject.end(body);
  });
});
httpServer.listen(controlPort, "0.0.0.0");
function closeAll() {
  if (closing) return;
  closing = true;
  pendingRestart = false;
  stop("shutdown");
  httpServer.close(() => process.exit(0));
}
process.on("SIGTERM", closeAll);
process.on("SIGINT", closeAll);
start();
