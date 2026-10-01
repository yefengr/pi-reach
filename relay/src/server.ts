import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { createChallenge, verifyAuth } from "./auth.js";
import { resolveRelayLimits, type RelayLimits } from "./config.js";
import { DiscoveryCapacityError } from "./discovery-budget.js";
import { PeerRegistry, type Outbound } from "./registry.js";
import { BoundedTransport, TransportPool } from "./transport.js";
import { RELAY_VERSION } from "./version.js";
import {
  frameType,
  parseEndpointUpdate,
  parseHello,
  parseJsonObject,
  parsePairingOffer,
  parseResolvePairingCode,
  parseRoute,
  parseSubscription,
  type ParsedHello,
  WireError,
} from "./wire.js";

export type RelayLogEvent = {
  event: "connection_rejected" | "connection_closed" | "authenticated" | "frame_dropped" | "route_dropped" | "pairing_result" | "transport_overflow";
  role?: "host" | "owner";
  outcome?: string;
};
export type StartRelayOptions = {
  host?: string;
  port?: number;
  limits?: Partial<RelayLimits>;
  logger?: (event: RelayLogEvent) => void;
};
export type RelayHandle = { port: number; close(): Promise<void> };

type AuthenticatedConnection =
  | { role: "host"; deviceId: string; endpointId: string; connId: number }
  | { role: "owner"; ownerId: string; connId: number };

type BudgetReservation = { pending: boolean; released: boolean };

export async function startRelay(options: StartRelayOptions = {}): Promise<RelayHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = validatePort(options.port ?? 3000);
  const limits = resolveRelayLimits(options.limits);
  const logger = safeLogger(options.logger);
  const registry = new PeerRegistry(Date.now, limits);
  const transports = new TransportPool(limits);
  const budget = new ConnectionBudget(limits.maxConnections, limits.maxPendingAuth);
  const sessions = new Set<PeerSession>();
  const httpSockets = new Set<Socket>();
  const httpDeadlines = new Map<Duplex, NodeJS.Timeout>();
  const maxHttpSockets = limits.maxConnections + limits.maxPendingAuth;
  let closing = false;
  const clearHttpDeadline = (socket: Duplex) => {
    const deadline = httpDeadlines.get(socket);
    if (deadline !== undefined) clearTimeout(deadline);
    httpDeadlines.delete(socket);
  };

  const server = createServer(
    { connectionsCheckingInterval: Math.min(limits.helloTimeoutMs, 1_000) },
    (request, response) => {
      clearHttpDeadline(request.socket);
      handleHttp(request, response);
    },
  );
  server.headersTimeout = limits.helloTimeoutMs;
  server.requestTimeout = Math.max(limits.helloTimeoutMs, limits.authTimeoutMs);
  server.keepAliveTimeout = limits.helloTimeoutMs;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: limits.maxFrameBytes });

  server.on("connection", (socket) => {
    if (closing || httpSockets.size >= maxHttpSockets) {
      socket.destroy();
      return;
    }
    httpSockets.add(socket);
    const deadline = setTimeout(() => socket.destroy(), limits.helloTimeoutMs);
    deadline.unref();
    httpDeadlines.set(socket, deadline);
    socket.on("close", () => {
      clearHttpDeadline(socket);
      httpSockets.delete(socket);
    });
  });
  server.on("upgrade", (request, socket, head) => {
    clearHttpDeadline(socket);
    if (closing || pathname(request.url) !== "/") {
      rejectUpgrade(socket, closing ? 503 : 404);
      return;
    }
    const reservation = budget.reserve();
    if (reservation === undefined) {
      logger({ event: "connection_rejected", outcome: "capacity" });
      rejectUpgrade(socket, 503);
      return;
    }
    const releaseIncompleteUpgrade = () => budget.release(reservation);
    socket.once("close", releaseIncompleteUpgrade);
    try {
      wss.handleUpgrade(request, socket, head, (ws) => {
        socket.off("close", releaseIncompleteUpgrade);
        const session = new PeerSession(ws, reservation, budget, registry, transports, limits, logger, () => sessions.delete(session));
        sessions.add(session);
        session.start();
      });
    } catch {
      socket.off("close", releaseIncompleteUpgrade);
      budget.release(reservation);
      socket.destroy();
    }
  });

  await listen(server, host, port);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServerImmediately(server);
    throw new Error("relay did not bind a TCP port");
  }

  let closePromise: Promise<void> | undefined;
  return {
    port: address.port,
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      closePromise = shutdown(server, wss, sessions, httpSockets, limits.shutdownTimeoutMs);
      return closePromise;
    },
  };
}

class PeerSession {
  private state: "hello" | "auth" | "registering" | "ready" | "closed" = "hello";
  private hello?: ParsedHello;
  private nonce?: Buffer;
  private connection?: AuthenticatedConnection;
  private timer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private closeTimer?: NodeJS.Timeout;
  private awaitingPong = false;
  private cleaned = false;
  private readonly transport: BoundedTransport;

  constructor(
    private readonly socket: WebSocket,
    private readonly reservation: BudgetReservation,
    private readonly budget: ConnectionBudget,
    private readonly registry: PeerRegistry,
    transports: TransportPool,
    private readonly limits: RelayLimits,
    private readonly logger: (event: RelayLogEvent) => void,
    private readonly onClosed: () => void,
  ) {
    this.transport = transports.attach(
      socket,
      () => {
        this.logger({ event: "transport_overflow", role: this.connection?.role });
        this.deactivate();
      },
      () => this.deactivate(),
    );
  }

  start(): void {
    this.socket.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    this.socket.on("pong", () => { this.awaitingPong = false; });
    this.socket.on("close", () => this.cleanup());
    this.socket.on("error", () => this.deactivate());
    this.setDeadline(this.limits.helloTimeoutMs);
  }

  close(): void {
    this.beginClose(1001, "server shutdown");
  }

  terminate(): void {
    this.deactivate();
    this.clearCloseTimer();
    this.socket.terminate();
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.state === "closed") return;
    if (isBinary) {
      if (this.state !== "ready") this.rejectHandshake("binary_handshake");
      return;
    }
    const text = rawText(data);
    if (this.state === "hello") this.handleHello(text);
    else if (this.state === "auth") this.handleAuth(text);
    else if (this.state === "ready") this.handleReady(text);
  }

  private handleHello(text: string): void {
    try {
      const hello = parseHello(parseJsonObject(text), this.limits);
      const challenge = createChallenge();
      this.hello = hello;
      this.nonce = challenge.nonce;
      this.state = "auth";
      this.setDeadline(this.limits.authTimeoutMs);
      if (!this.transport.send(challenge.line)) this.deactivate();
    } catch {
      this.rejectHandshake("invalid_hello");
    }
  }

  private handleAuth(text: string): void {
    const hello = this.hello;
    const nonce = this.nonce;
    const identity = hello?.role === "host" ? hello.deviceId : hello?.ownerId;
    if (hello === undefined || nonce === undefined || identity === undefined || !verifyAuth(identity, nonce, text)) {
      this.rejectHandshake("invalid_auth");
      return;
    }
    this.clearDeadline();
    this.budget.authenticate(this.reservation);
    this.state = "registering";
    const outbound: Outbound = { send: (line) => this.transport.send(line), isOpen: () => this.transport.isOpen };
    let connection: AuthenticatedConnection;
    try {
      connection = hello.role === "host"
        ? { role: "host", deviceId: hello.deviceId, endpointId: hello.endpointId, connId: this.registry.registerHost(hello, outbound) }
        : { role: "owner", ownerId: hello.ownerId, connId: this.registry.registerOwner(hello.ownerId, outbound) };
    } catch (error) {
      if (error instanceof DiscoveryCapacityError) {
        this.rejectHandshake("discovery_capacity");
        return;
      }
      throw error;
    }
    if (this.isClosed()) {
      if (connection.role === "host") this.registry.unregisterHost(connection.deviceId, connection.endpointId, connection.connId);
      else this.registry.unregisterOwner(connection.ownerId, connection.connId);
      return;
    }
    this.connection = connection;
    this.hello = undefined;
    this.nonce = undefined;
    this.state = "ready";
    if (connection.role === "owner" && !this.transport.send(JSON.stringify({ type: "relay_info", version: RELAY_VERSION }))) {
      this.deactivate();
      return;
    }
    if (this.isClosed()) return;
    this.startHeartbeat();
    this.logger({ event: "authenticated", role: connection.role });
  }

  private handleReady(text: string): void {
    const connection = this.connection;
    if (connection === undefined) return;
    try {
      const value = parseJsonObject(text);
      const type = frameType(value);
      if (connection.role === "owner" && type === "subscribe_endpoints") {
        this.registry.subscribeEndpoints(connection.ownerId, connection.connId, parseSubscription(value, this.limits));
      } else if (connection.role === "owner" && type === "resolve_pairing_code") {
        const outcome = this.registry.resolvePairingCode(connection.ownerId, connection.connId, parseResolvePairingCode(value));
        this.logger({ event: "pairing_result", role: "owner", outcome });
      } else if (connection.role === "owner" && type === "route") {
        const outcome = this.registry.routeFromOwner(connection.ownerId, connection.connId, parseRoute(value));
        if (outcome !== "delivered") this.logger({ event: "route_dropped", role: "owner", outcome });
      } else if (connection.role === "host" && type === "endpoint_update") {
        this.registry.updateHost(connection.deviceId, connection.endpointId, connection.connId, parseEndpointUpdate(value, this.limits));
      } else if (connection.role === "host" && type === "pairing_offer") {
        const accepted = this.registry.publishPairingOffer(connection.deviceId, connection.endpointId, connection.connId, parsePairingOffer(value));
        if (!accepted) this.logger({ event: "frame_dropped", role: "host", outcome: "pairing_offer_rejected" });
      } else if (connection.role === "host" && type === "route") {
        const outcome = this.registry.routeFromHost(connection.deviceId, connection.endpointId, connection.connId, parseRoute(value));
        if (outcome !== "delivered") this.logger({ event: "route_dropped", role: "host", outcome });
      } else {
        this.logger({ event: "frame_dropped", role: connection.role, outcome: "direction" });
      }
    } catch (error) {
      const discoveryCapacity = error instanceof DiscoveryCapacityError;
      const exceededLimit = discoveryCapacity || (error instanceof WireError && error.kind === "limit");
      this.logger({
        event: "frame_dropped",
        role: connection.role,
        outcome: discoveryCapacity ? "discovery_capacity" : exceededLimit ? "limit" : "invalid",
      });
      if (exceededLimit) this.closePolicyViolation();
    }
  }

  private closePolicyViolation(): void {
    this.beginClose(1008, "policy violation");
  }

  private rejectHandshake(outcome: string): void {
    this.logger({ event: "connection_rejected", outcome });
    this.beginClose(1008, "policy violation");
  }

  private beginClose(code: number, reason: string): void {
    this.deactivate();
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(code, reason);
      this.closeTimer = setTimeout(() => this.terminate(), this.limits.shutdownTimeoutMs);
      this.closeTimer.unref();
    } else if (this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.terminate();
    }
  }

  private clearCloseTimer(): void {
    if (this.closeTimer !== undefined) clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }

  private setDeadline(milliseconds: number): void {
    this.clearDeadline();
    this.timer = setTimeout(() => this.rejectHandshake("auth_timeout"), milliseconds);
    this.timer.unref();
  }

  private clearDeadline(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      if (this.awaitingPong) {
        this.terminate();
        return;
      }
      if (this.socket.readyState !== WebSocket.OPEN) return;
      this.awaitingPong = true;
      this.socket.ping();
    }, this.limits.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  private isClosed(): boolean {
    return this.state === "closed";
  }

  private deactivate(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.clearDeadline();
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const connection = this.connection;
    this.connection = undefined;
    this.hello = undefined;
    this.nonce = undefined;
    if (connection?.role === "host") this.registry.unregisterHost(connection.deviceId, connection.endpointId, connection.connId);
    else if (connection?.role === "owner") this.registry.unregisterOwner(connection.ownerId, connection.connId);
    this.budget.releasePending(this.reservation);
  }

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    const role = this.connection?.role;
    this.deactivate();
    this.clearCloseTimer();
    this.transport.detach();
    this.budget.release(this.reservation);
    this.onClosed();
    this.logger({ event: "connection_closed", role });
  }
}

class ConnectionBudget {
  private connections = 0;
  private pending = 0;

  constructor(private readonly maxConnections: number, private readonly maxPending: number) {}

  reserve(): BudgetReservation | undefined {
    if (this.connections >= this.maxConnections || this.pending >= this.maxPending) return undefined;
    this.connections += 1;
    this.pending += 1;
    return { pending: true, released: false };
  }

  authenticate(reservation: BudgetReservation): void {
    this.releasePending(reservation);
  }

  releasePending(reservation: BudgetReservation): void {
    if (!reservation.pending) return;
    reservation.pending = false;
    this.pending -= 1;
  }

  release(reservation: BudgetReservation): void {
    if (reservation.released) return;
    this.releasePending(reservation);
    reservation.released = true;
    this.connections -= 1;
  }
}

function handleHttp(request: IncomingMessage, response: ServerResponse): void {
  if ((request.method === "GET" || request.method === "HEAD") && pathname(request.url) === "/health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": "2" });
    response.end(request.method === "HEAD" ? undefined : "OK");
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not Found");
}

function pathname(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try { return new URL(url, "http://relay.invalid").pathname; } catch { return undefined; }
}

function rejectUpgrade(socket: Duplex, status: 404 | 503): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const reason = status === 404 ? "Not Found" : "Service Unavailable";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function rawText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function validatePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error("port must be an integer from 0 to 65535");
  return value;
}

function safeLogger(logger: StartRelayOptions["logger"]): (event: RelayLogEvent) => void {
  if (logger === undefined) return () => undefined;
  return (event) => { try { logger(event); } catch { /* Logging cannot affect routing. */ } };
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServerImmediately(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function shutdown(
  server: Server,
  wss: WebSocketServer,
  sessions: Set<PeerSession>,
  sockets: Set<Socket>,
  timeoutMs: number,
): Promise<void> {
  for (const session of [...sessions]) session.close();
  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  let deadline: NodeJS.Timeout | undefined;
  const forced = new Promise<void>((resolve) => {
    deadline = setTimeout(() => {
      for (const session of [...sessions]) session.terminate();
      for (const socket of [...sockets]) socket.destroy();
      server.closeAllConnections();
      resolve();
    }, timeoutMs);
  });
  await Promise.race([serverClosed, forced]);
  if (deadline !== undefined) clearTimeout(deadline);
  if (sessions.size > 0) {
    for (const session of [...sessions]) session.terminate();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}
