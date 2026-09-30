import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";

const OWNER_KEY = Symbol.for("pi-reach.endpoint-extension-owner");
type SessionIdentity = { sessionId: string; sessionFile?: string };
type Handoff = SessionIdentity & { owner: ExtensionOwner; reason: Exclude<SessionShutdownEvent["reason"], "quit">; targetSessionFile?: string };
type OwnerState = { owner?: ExtensionOwner; handoff?: Handoff };
type OwnerGlobal = typeof globalThis & { [OWNER_KEY]?: OwnerState };

function ownerState(): OwnerState {
  return (globalThis as OwnerGlobal)[OWNER_KEY] ??= {};
}

/** 一个进程只暴露主会话；同进程 SDK 子会话不得接管它的连接或生命周期。 */
export class ExtensionOwner {
  private rejected = false;
  private session: SessionIdentity | undefined;

  isCurrent(): boolean {
    return ownerState().owner === this;
  }

  activate(event: SessionStartEvent, ctx: ExtensionContext): boolean {
    if (this.rejected) return false;
    const state = ownerState();
    if (state.owner && state.owner !== this) {
      this.rejected = true;
      return false;
    }
    const session = { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile?.() };
    const handoff = state.handoff;
    if (handoff && !this.matchesHandoff(handoff, event, session)) {
      this.rejected = true;
      return false;
    }
    state.owner = this;
    state.handoff = undefined;
    this.session = session;
    return true;
  }

  release(event: SessionShutdownEvent): void {
    if (!this.isCurrent()) return;
    const state = ownerState();
    state.owner = undefined;
    state.handoff = event.reason !== "quit" && this.session
      ? { ...this.session, owner: this, reason: event.reason, targetSessionFile: event.targetSessionFile }
      : undefined;
    // 即使主会话已退出，先前拒绝的子实例也不能由后续事件抢占 endpoint。
  }

  private matchesHandoff(handoff: Handoff, event: SessionStartEvent, session: SessionIdentity): boolean {
    if (event.reason !== handoff.reason) return false;
    if (event.reason === "reload") return session.sessionId === handoff.sessionId;
    if (event.previousSessionFile !== handoff.sessionFile) return false;
    return !handoff.targetSessionFile || session.sessionFile === handoff.targetSessionFile;
  }

  guard(pi: ExtensionAPI): ExtensionAPI {
    // SDK 的 on 使用重载；这里只转发原参数，并在调用时检查实例所有权。
    type RegisterEvent = (name: string, handler: (...args: unknown[]) => unknown) => void;
    const on = ((name: string, handler: (...args: unknown[]) => unknown) => {
      (pi.on as unknown as RegisterEvent)(name, (...args) => this.isCurrent() ? handler(...args) : undefined);
    }) as ExtensionAPI["on"];
    const registerCommand: ExtensionAPI["registerCommand"] = (name, command) => {
      pi.registerCommand(name, {
        ...command,
        handler: async (args, ctx) => {
          if (!this.isCurrent() && ownerState().handoff?.owner !== this) {
            ctx.ui.notify("[pi-reach] This endpoint belongs to the primary Pi session.", "warning");
            return;
          }
          await command.handler(args, ctx);
        },
      });
    };
    return new Proxy(pi, {
      get(target, key, receiver) {
        if (key === "on") return on;
        if (key === "registerCommand") return registerCommand;
        return Reflect.get(target, key, receiver);
      },
    });
  }
}

export function resetExtensionOwnerForTest(): void {
  delete (globalThis as OwnerGlobal)[OWNER_KEY];
}
