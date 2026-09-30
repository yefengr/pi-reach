import WebSocket from "ws";

export type TransportLimits = { maxBufferedBytes: number; maxTotalBufferedBytes: number };
export type TransportSocket = {
  readyState: number;
  readonly bufferedAmount: number;
  send(text: string, callback: (error?: Error) => void): void;
  terminate(): void;
};

export class TransportPool {
  private readonly connections = new Set<BoundedTransport>();

  constructor(private readonly limits: TransportLimits) {}

  attach(socket: TransportSocket, onOverflow: () => void, onFailure: () => void = onOverflow): BoundedTransport {
    const transport = new BoundedTransport(socket, this, this.limits.maxBufferedBytes, onOverflow, onFailure);
    this.connections.add(transport);
    return transport;
  }

  detach(transport: BoundedTransport): void {
    this.connections.delete(transport);
  }

  reserve(transport: BoundedTransport, bytes: number): boolean {
    if (transport.bufferedBytes + bytes > this.limits.maxBufferedBytes) {
      transport.evict();
      return false;
    }
    while (this.totalBufferedBytes() + bytes > this.limits.maxTotalBufferedBytes) {
      const slowest = this.slowestConnection();
      if (slowest === undefined) {
        transport.evict();
        return false;
      }
      slowest.evict();
      if (slowest === transport) return false;
    }
    return !transport.isDetached;
  }

  private totalBufferedBytes(): number {
    let total = 0;
    for (const connection of this.connections) total += connection.bufferedBytes;
    return total;
  }

  private slowestConnection(): BoundedTransport | undefined {
    let slowest: BoundedTransport | undefined;
    for (const connection of this.connections) {
      if (connection.bufferedBytes === 0) continue;
      if (slowest === undefined || connection.bufferedBytes > slowest.bufferedBytes) slowest = connection;
    }
    return slowest;
  }
}

export class BoundedTransport {
  private pendingCallbackBytes = 0;
  private detached = false;
  private overflowed = false;

  constructor(
    readonly socket: TransportSocket,
    private readonly pool: TransportPool,
    private readonly maxBufferedBytes: number,
    private readonly onOverflow: () => void,
    private readonly onFailure: () => void,
  ) {}

  get bufferedBytes(): number {
    if (this.detached) return 0;
    return Math.max(this.pendingCallbackBytes, this.socket.bufferedAmount);
  }

  get isDetached(): boolean {
    return this.detached;
  }

  get isOpen(): boolean {
    return !this.detached && this.socket.readyState === WebSocket.OPEN;
  }

  send(text: string): boolean {
    if (this.detached || this.socket.readyState !== WebSocket.OPEN) return false;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.maxBufferedBytes || !this.pool.reserve(this, bytes)) {
      if (!this.detached) this.evict();
      return false;
    }
    this.pendingCallbackBytes += bytes;
    try {
      this.socket.send(text, (error) => {
        this.pendingCallbackBytes = Math.max(0, this.pendingCallbackBytes - bytes);
        if (error) this.failSend();
      });
      return true;
    } catch {
      this.pendingCallbackBytes = Math.max(0, this.pendingCallbackBytes - bytes);
      this.failSend();
      return false;
    }
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.pendingCallbackBytes = 0;
    this.pool.detach(this);
  }

  evict(): void {
    if (this.overflowed) return;
    this.overflowed = true;
    this.detach();
    this.onOverflow();
    this.socket.terminate();
  }

  private failSend(): void {
    if (this.detached) return;
    this.detach();
    this.onFailure();
    this.socket.terminate();
  }
}
