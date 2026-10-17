import { useEffect } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { useSessionActions } from "./use-session-actions";
import { OPERATION_CONFIRMATION_TIMEOUT_MS } from "./operation-feedback";

type Actions = ReturnType<typeof useSessionActions>;
function Harness({ expose }: { expose: (actions: Actions) => void }) {
  const actions = useSessionActions();
  useEffect(() => { expose(actions); });
  return <><output data-testid="action">{actions.pendingAction?.phase ?? "none"}</output><output data-testid="stop">{actions.stopRequest ? actions.stopRequest.unknown ? "unknown" : "waiting" : "none"}</output></>;
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
  } finally { vi.useRealTimers(); await screen.unmount(); }
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
