import { useEffect } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { useI18n } from "@/lib/i18n";
import { useSessionActions } from "./use-session-actions";
import { OPERATION_CONFIRMATION_TIMEOUT_MS, operationHint } from "./operation-feedback";

type Actions = ReturnType<typeof useSessionActions>;
function Harness({ expose }: { expose: (actions: Actions) => void }) {
  const actions = useSessionActions();
  const { t } = useI18n();
  const hint = operationHint(actions.pendingAction, actions.stopRequest, t.operationFeedback);
  useEffect(() => { expose(actions); });
  return <>{hint ? <p>{hint.text}</p> : null}<output data-testid="action">{actions.pendingAction?.phase ?? "none"}</output><output data-testid="stop">{actions.stopRequest ? actions.stopRequest.unknown ? "unknown" : "waiting" : "none"}</output></>;
}
afterEach(() => vi.useRealTimers());

test("timeout preserves unknown action and stop targets; it never invents failure or clears their lock", async () => {
  let actions!: Actions;
  const screen = await renderPwa(<Harness expose={(value) => { actions = value; }} />);
  try {
    vi.useFakeTimers();
    actions.setPendingAction({ id: "new", sessionId: "session", action: "session_new", phase: "pending", startedAt: Date.now(), projection: [] });
    actions.setStopRequest({ id: "stop", sessionId: "session", leafId: "leaf", groupId: "group", startedAt: Date.now(), unknown: false });
    expect(actions.pendingActionRef.current?.id).toBe("new");
    expect(actions.stopRequestRef.current?.groupId).toBe("group");
    await expect.element(screen.getByTestId("action")).toHaveTextContent("pending");
    await expect.element(screen.getByTestId("stop")).toHaveTextContent("waiting");
    await vi.advanceTimersByTimeAsync(OPERATION_CONFIRMATION_TIMEOUT_MS);
    await expect.element(screen.getByTestId("action")).toHaveTextContent("unknown");
    await expect.element(screen.getByTestId("stop")).toHaveTextContent("unknown");
    expect(actions.pendingActionRef.current?.id).toBe("new");
    expect(actions.stopRequestRef.current?.groupId).toBe("group");
    actions.setStopRequest({ ...actions.stopRequestRef.current!, accepted: true });
    await expect.element(screen.getByText("Stop result not confirmed. Wait for reconnection to check this run.", { exact: true })).toBeVisible();
    expect(screen.getByText("Stop requested. Waiting for this run to end…", { exact: true }).query()).toBeNull();
  } finally { vi.useRealTimers(); await screen.unmount(); }
});

test.each([
  ["session_new", "New session not confirmed. Reconnect to check before creating another."],
  ["session_compact", "Compaction not confirmed. Reconnect to check before compacting again."],
  ["model_set", "Configuration not confirmed. Reconnect to check the actual model and thinking level."],
  ["thinking_set", "Configuration not confirmed. Reconnect to check the actual model and thinking level."],
] as const)("unknown %s explains its own safe next step without retrying", async (action, message) => {
  let actions!: Actions;
  const screen = await renderPwa(<Harness expose={value => { actions = value; }} />);
  try {
    actions.setPendingAction({ id: "request", sessionId: "session", action, phase: "unknown", startedAt: Date.now() });
    await expect.element(screen.getByText(message, { exact: true })).toBeVisible();
  } finally { await screen.unmount(); }
});

test("disconnect preserves new-session evidence, while explicit scope reset rejects late replies", async () => {
  let actions!: Actions;
  const screen = await renderPwa(<Harness expose={(value) => { actions = value; }} />);
  try {
    actions.setPendingAction({ id: "new", sessionId: "session", action: "session_new", phase: "pending", startedAt: Date.now(), projection: [] });
    actions.observeSession("target", true);
    actions.disconnectActions();
    expect(actions.pendingActionRef.current).toMatchObject({ phase: "unknown", readySessionId: "target", dataSessionId: "target" });
    actions.resetActions();
    actions.receiveAction({ protocol_version: 2, type: "action_ok", target_channel_id: "channel", in_reply_to: "new", action: "session_new", session_id: "target" });
    await expect.element(screen.getByTestId("action")).toHaveTextContent("none");
    expect(actions.pendingActionRef.current).toBeNull();
  } finally { await screen.unmount(); }
});
