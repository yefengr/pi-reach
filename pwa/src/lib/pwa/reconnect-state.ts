export type ReconnectTrigger = "closed" | "error" | "connect_rejected";

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;

export function reconnectDelayMs(attempt: number): number {
  const normalized = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return RETRY_DELAYS_MS[Math.min(normalized, RETRY_DELAYS_MS.length) - 1];
}

/** Gates reconnect requests for one transport lifecycle and terminal bye state. */
export class ReconnectState {
  private terminal = false;
  private scheduled = false;
  private connectionToken = 0;

  get isTerminal(): boolean {
    return this.terminal;
  }

  beginConnection(): number {
    this.connectionToken += 1;
    this.scheduled = false;
    return this.connectionToken;
  }

  replacementBye(): void {
    this.connectionToken += 1;
    this.terminal = false;
    this.scheduled = false;
  }

  terminalBye(): void {
    this.connectionToken += 1;
    this.terminal = true;
    this.scheduled = true;
  }

  userRecover(): void {
    this.connectionToken += 1;
    this.terminal = false;
    this.scheduled = false;
  }

  /** Invalidates pending callbacks without changing whether recovery is terminal. */
  cancel(): void {
    this.connectionToken += 1;
    this.scheduled = false;
  }

  request(trigger: ReconnectTrigger, schedule: (trigger: ReconnectTrigger) => void, token = this.connectionToken): boolean {
    if (token !== this.connectionToken || this.terminal || this.scheduled) return false;
    this.scheduled = true;
    schedule(trigger);
    return true;
  }
}
