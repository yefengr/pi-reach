import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ClientFrame, ServerFrame } from "../protocol/v2/index.js";
import { collectPublications } from "../files/publications.js";
import { FileReaderRuntime, type FileScope } from "../files/reader.js";
import type { OwnerBinding } from "./create_owner_binding.js";

type FileFrame = Extract<ClientFrame, { type: "file_open" | "file_read" | "file_close" }>;
type BindingOptions = {
  runtimeId: string;
  getManager: () => SessionManager | null;
  getBinding: (ownerId: string) => OwnerBinding | undefined;
};

export function isFileFrame(frame: ClientFrame): frame is FileFrame {
  return frame.type === "file_open" || frame.type === "file_read" || frame.type === "file_close";
}

/** 共用发布检查与读取账目；会话代际只在真实 reset 推进，不随普通 leaf 变化。 */
export class FileBinding {
  generation = 0;
  readonly reader: FileReaderRuntime;

  constructor(private readonly options: BindingOptions) {
    this.reader = new FileReaderRuntime({
      isCurrent: (scope) => this.isCurrent(scope),
      resolve: (scope, id) => {
        const manager = options.getManager();
        if (!manager || !this.isCurrent(scope)) return null;
        const publication = collectPublications(manager).get(id);
        return publication ? { sourcePath: publication.sourcePath } : null;
      },
    });
  }

  private isCurrent(scope: FileScope): boolean {
    const binding = this.options.getBinding(scope.ownerId);
    return scope.generation === this.generation && scope.runtimeId === this.options.runtimeId
      && this.options.getManager()?.getSessionId() === scope.sessionId
      && binding?.service.sessionId === scope.sessionId;
  }

  async handle(frame: FileFrame, ownerId: string, binding: OwnerBinding): Promise<ServerFrame[]> {
    const invalid = binding.service.validateRequest(frame);
    if (invalid) return [invalid];
    const response = await this.reader.handle(frame, {
      ownerId, channelId: frame.channel_id, sessionId: frame.session_id,
      runtimeId: this.options.runtimeId, generation: this.generation,
    });
    const changed = binding.service.validateRequest(frame);
    return [changed ?? response];
  }

  closeOwner(ownerId: string): void {
    void this.reader.closeWhere((scope) => scope.ownerId === ownerId).catch(() => undefined);
  }

  invalidate(): void {
    this.generation += 1;
    void this.reader.closeWhere(() => true).catch(() => undefined);
  }
}
