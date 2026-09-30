import { expect, test, vi } from "vitest";
import { notifications } from "@mantine/notifications";
import { createOperationNotificationController, OPERATION_NOTIFICATION_ID, operationFeedbackMessage, type OperationFeedback } from "./operation-notifications";

function controller() {
  const value = createOperationNotificationController();
  value.activate();
  return value;
}

test("replaces every operation in one stable slot without a queue", () => {
  const value = controller();
  const operations: OperationFeedback[] = ["registry-save", "model_set-error", "model_set-error", "thinking_set-send-failed", "stop-send-failed"];
  for (const operation of operations) {
    value.show(operation);
    expect(value.store.getState().notifications).toMatchObject([{
      id: OPERATION_NOTIFICATION_ID, message: operationFeedbackMessage(operation), autoClose: false, position: "top-center", role: "status",
    }]);
    expect(value.store.getState().notifications).toHaveLength(1);
    expect(value.store.getState().queue).toEqual([]);
  }
});

test("success clears only the matching action and never a newer different result", () => {
  const value = controller();
  value.show("model_set-error");
  value.clearAction("thinking_set");
  expect(value.store.getState().notifications).toHaveLength(1);
  value.clearAction("model_set");
  expect(value.store.getState().notifications).toEqual([]);
  value.show("model_set-send-failed");
  value.show("registry-save");
  value.clearAction("model_set");
  value.clearSession();
  expect(value.store.getState().notifications[0].message).toBe(operationFeedbackMessage("registry-save"));
});

test("session changes revoke session and stop feedback but retain application feedback", () => {
  const value = controller();
  for (const operation of ["session_new-error", "session_compact-error", "stop-send-failed"] as const) {
    value.show(operation);
    value.clearSession();
    expect(value.store.getState().notifications).toEqual([]);
  }
  value.show("stop-send-failed");
  value.clearAction("session_compact");
  expect(value.store.getState().notifications).toHaveLength(1);
  value.clearStop();
  expect(value.store.getState().notifications).toEqual([]);
});

test("manual dismissal stays cleared until a new failure occurs", () => {
  const value = controller();
  value.show("model_set-error");
  notifications.hide(OPERATION_NOTIFICATION_ID, value.store);
  value.clearAction("model_set");
  expect(value.store.getState().notifications).toEqual([]);
  value.show("model_set-error");
  expect(value.store.getState().notifications).toHaveLength(1);
  expect(value.store.getState().queue).toEqual([]);
});

test("inactive and disposed controllers ignore late callbacks and cannot pollute a fresh mount", () => {
  const old = createOperationNotificationController();
  old.show("registry-save");
  expect(old.store.getState().notifications).toEqual([]);
  old.activate();
  old.show("registry-save");
  const late = old.show;
  old.dispose();
  const fresh = controller();
  fresh.show("thinking_set-error");
  late("model_set-error");
  expect(old.store.getState().notifications).toEqual([]);
  expect(old.store.getState().queue).toEqual([]);
  expect(fresh.store.getState().notifications[0].message).toBe(operationFeedbackMessage("thinking_set-error"));
});

test("plain toasts close after four seconds and pause while hovered or focused", () => {
  vi.useFakeTimers();
  try {
    const value = controller();
    value.notify("Settings saved");
    expect(value.store.getState().notifications).toMatchObject([{ id: OPERATION_NOTIFICATION_ID, message: "Settings saved", autoClose: false, role: "status" }]);
    vi.advanceTimersByTime(3_000);
    value.pauseAutoClose("hover");
    vi.advanceTimersByTime(10_000);
    expect(value.store.getState().notifications).toHaveLength(1);
    value.pauseAutoClose("focus");
    value.resumeAutoClose("hover");
    vi.advanceTimersByTime(10_000);
    expect(value.store.getState().notifications).toHaveLength(1);
    value.resumeAutoClose("focus");
    vi.advanceTimersByTime(999);
    expect(value.store.getState().notifications).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(value.store.getState().notifications).toEqual([]);
  } finally { vi.useRealTimers(); }
});

test("toasts with an action stay until dismissed and new plain toasts replace older ones", () => {
  vi.useFakeTimers();
  try {
    const value = controller();
    value.notify("Update ready", { kind: "info", action: { label: "Refresh", onClick: () => {} } });
    vi.advanceTimersByTime(60_000);
    expect(value.store.getState().notifications).toHaveLength(1);
    value.notify("Copied");
    expect(value.store.getState().notifications).toMatchObject([{ message: "Copied" }]);
    expect(value.store.getState().notifications).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

test("an update stays in the single slot ahead of ordinary toasts, survives errors, and dismisses into the pending toast", async () => {
  const value = controller();
  const onRefresh = vi.fn();
  const onDismiss = vi.fn();
  value.showUpdate("Update ready", { label: "Refresh", onClick: onRefresh }, onDismiss);
  value.notify("Settings saved");
  expect(value.store.getState().notifications).toHaveLength(1);
  expect(value.store.getState().notifications[0].message).not.toBe("Settings saved");
  value.show("model_set-error");
  expect(value.store.getState().notifications[0].message).toBe(operationFeedbackMessage("model_set-error"));
  value.notify("Connection restored");
  value.clearAction("model_set");
  const update = value.store.getState().notifications[0];
  expect(update.message).not.toBe("Connection restored");
  expect(value.store.getState().queue).toEqual([]);
  notifications.hide(OPERATION_NOTIFICATION_ID, value.store);
  await vi.waitFor(() => expect(value.store.getState().notifications).toMatchObject([{ message: "Connection restored" }]));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("an update arriving before renderer activation is displayed once activated and later update can repeat", async () => {
  const value = createOperationNotificationController();
  const dismissed = vi.fn();
  value.showUpdate("Update ready", { label: "Refresh", onClick: () => {} }, dismissed);
  expect(value.store.getState().notifications).toEqual([]);
  value.activate();
  expect(value.store.getState().notifications).toHaveLength(1);
  notifications.hide(OPERATION_NOTIFICATION_ID, value.store);
  expect(dismissed).toHaveBeenCalledTimes(1);
  value.showUpdate("Newer version ready", { label: "Refresh", onClick: () => {} }, dismissed);
  expect(value.store.getState().notifications).toHaveLength(1);
  value.dispose();
  expect(value.store.getState().notifications).toEqual([]);
});

test("a plain toast waits behind a current error and appears once the error is cleared", () => {
  vi.useFakeTimers();
  try {
    const value = controller();
    value.notify("Copied");
    value.show("model_set-error");
    expect(value.store.getState().notifications[0].message).toBe(operationFeedbackMessage("model_set-error"));
    value.notify("Connection restored");
    vi.advanceTimersByTime(60_000);
    expect(value.store.getState().notifications[0].message).toBe(operationFeedbackMessage("model_set-error"));
    value.clearAction("model_set");
    expect(value.store.getState().notifications).toMatchObject([{ message: "Connection restored" }]);
    vi.advanceTimersByTime(4_000);
    expect(value.store.getState().notifications).toEqual([]);
  } finally { vi.useRealTimers(); }
});
