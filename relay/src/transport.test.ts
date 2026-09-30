import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { TransportPool, type TransportSocket } from "./transport.js";

class FakeSocket implements TransportSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  terminated = 0;
  throwOnSend = false;
  private readonly callbacks: Array<{ bytes: number; callback: (error?: Error) => void }> = [];

  send(text: string, callback: (error?: Error) => void): void {
    if (this.throwOnSend) throw new Error("send failed");
    const bytes = Buffer.byteLength(text);
    this.bufferedAmount += bytes;
    this.callbacks.push({ bytes, callback });
  }

  flush(error?: Error): void {
    const pending = this.callbacks.shift();
    if (pending === undefined) throw new Error("no pending send");
    this.bufferedAmount = Math.max(0, this.bufferedAmount - pending.bytes);
    pending.callback(error);
  }

  terminate(): void {
    this.terminated += 1;
    this.readyState = WebSocket.CLOSED;
  }
}

describe("bounded transport", () => {
  it("enforces a per-connection budget without double-counting socket and callback bytes", () => {
    const pool = new TransportPool({ maxBufferedBytes: 5, maxTotalBufferedBytes: 20 });
    const socket = new FakeSocket();
    let overflow = 0;
    const transport = pool.attach(socket, () => { overflow += 1; });
    expect(transport.send("1234")).toBe(true);
    expect(transport.bufferedBytes).toBe(4);
    expect(transport.send("12")).toBe(false);
    expect(overflow).toBe(1);
    expect(socket.terminated).toBe(1);
    socket.flush();
    expect(transport.bufferedBytes).toBe(0);
  });

  it("evicts the existing largest backlog before a healthy recipient", () => {
    const pool = new TransportPool({ maxBufferedBytes: 10, maxTotalBufferedBytes: 10 });
    const slowSocket = new FakeSocket();
    const healthySocket = new FakeSocket();
    let slowOverflow = 0;
    let healthyOverflow = 0;
    const slow = pool.attach(slowSocket, () => { slowOverflow += 1; });
    const healthy = pool.attach(healthySocket, () => { healthyOverflow += 1; });
    expect(slow.send("12345678")).toBe(true);
    expect(healthy.send("abc")).toBe(true);
    expect(slowOverflow).toBe(1);
    expect(slowSocket.terminated).toBe(1);
    expect(healthyOverflow).toBe(0);
    expect(healthySocket.terminated).toBe(0);
  });

  it("cleans callback accounting after detach and handles synchronous send failure", () => {
    const pool = new TransportPool({ maxBufferedBytes: 10, maxTotalBufferedBytes: 20 });
    const socket = new FakeSocket();
    const transport = pool.attach(socket, () => undefined);
    expect(transport.send("1234")).toBe(true);
    transport.detach();
    socket.flush();
    expect(transport.bufferedBytes).toBe(0);
    expect(transport.send("x")).toBe(false);

    const throwingSocket = new FakeSocket();
    throwingSocket.throwOnSend = true;
    let failures = 0;
    const throwing = pool.attach(throwingSocket, () => undefined, () => { failures += 1; });
    expect(throwing.send("x")).toBe(false);
    expect(throwing.isDetached).toBe(true);
    expect(throwingSocket.terminated).toBe(1);
    expect(failures).toBe(1);
  });
});
