import type { TimelineScope } from "./timeline-runtime";

export type MessageSendChannel = { readonly closed: boolean };
export type MessageSendIntent = {
  generation: number;
  channel: MessageSendChannel;
  scope: TimelineScope;
};
type CurrentMessageSendContext = {
  generation: number;
  channel: MessageSendChannel | null;
  scope: TimelineScope | null;
  online: boolean;
  historyMode: boolean;
};

/** Keep an awaited attachment from being delivered into a replacement live session. */
export function isCurrentMessageSendIntent(intent: MessageSendIntent, current: CurrentMessageSendContext): boolean {
  const scope = current.scope;
  return current.online && !current.historyMode && !intent.channel.closed && intent.generation === current.generation
    && intent.channel === current.channel && scope !== null && intent.scope.deviceId === scope.deviceId
    && intent.scope.endpointId === scope.endpointId && intent.scope.runtimeInstanceId === scope.runtimeInstanceId
    && intent.scope.sessionId === scope.sessionId && intent.scope.leafId === scope.leafId
    && intent.scope.selfSenderRef === scope.selfSenderRef && intent.scope.channelId === scope.channelId;
}
