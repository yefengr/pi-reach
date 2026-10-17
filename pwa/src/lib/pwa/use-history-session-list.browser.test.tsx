import { useEffect, useState } from "react";
import { expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { useHistorySessionList } from "./use-history-session-list";
import { listTimelineSessions, type TimelineSessionSummary } from "./timeline-store";

vi.mock("./timeline-store", () => ({ listTimelineSessions: vi.fn() }));

type Controller = { setDevice: (deviceId: string | null) => void; refresh: () => Promise<void> };
const summary = (deviceId: string): TimelineSessionSummary => ({
  id: `${deviceId}-session`, deviceId, endpointId: "endpoint", sessionId: "session", leafId: "generation", startedAt: 1, updatedAt: 1, eventCount: 1, preview: "preview",
});

function Harness({ onController, onError }: { onController: (controller: Controller) => void; onError: (message: string) => void }) {
  const [deviceId, setDeviceId] = useState<string | null>("device-a");
  const [sessions, setSessions] = useState<TimelineSessionSummary[]>([]);
  const history = useHistorySessionList({ deviceId, onError, onSessionsLoaded: setSessions });
  useEffect(() => { onController({ setDevice: setDeviceId, refresh: history.refreshHistory }); }, [history.refreshHistory, onController]);
  return <><output data-testid="history">{history.historySessions.map((session) => session.deviceId).join(",") || sessions.map((session) => session.deviceId).join(",")}</output><output data-testid="status">{history.historyListStatus}</output></>;
}

test("first failure is not empty success and retry preserves entries during refresh and failure", async () => {
  let controller: Controller | null = null;
  const onError = vi.fn();
  let rejectInitial!: (error: Error) => void;
  let rejectRefresh!: (error: Error) => void;
  vi.mocked(listTimelineSessions)
    .mockImplementationOnce(() => new Promise((_, reject) => { rejectInitial = reject; }))
    .mockResolvedValueOnce([summary("device-a")])
    .mockImplementationOnce(() => new Promise((_, reject) => { rejectRefresh = reject; }))
    .mockResolvedValueOnce([]);
  const screen = await renderPwa(<Harness onController={(value) => { controller = value; }} onError={onError} />);
  try {
    await expect.element(screen.getByTestId("status")).toHaveTextContent("loading");
    await vi.waitFor(() => expect(rejectInitial).toBeTypeOf("function"));
    rejectInitial(new Error("read failed"));
    await expect.element(screen.getByTestId("status")).toHaveTextContent("error");
    await controller!.refresh();
    await expect.element(screen.getByTestId("history")).toHaveTextContent("device-a");
    const refresh = controller!.refresh();
    await expect.element(screen.getByTestId("status")).toHaveTextContent("loading");
    await expect.element(screen.getByTestId("history")).toHaveTextContent("device-a");
    rejectRefresh(new Error("refresh failed")); await refresh;
    await expect.element(screen.getByTestId("status")).toHaveTextContent("error");
    await expect.element(screen.getByTestId("history")).toHaveTextContent("device-a");
    await controller!.refresh();
    await expect.element(screen.getByTestId("status")).toHaveTextContent("success");
    await expect.element(screen.getByTestId("history")).toHaveTextContent("");
    expect(onError).toHaveBeenCalledTimes(2);
  } finally { await screen.unmount(); }
});

test("ignores a late result and failure from the previous device", async () => {
  let controller: Controller | null = null;
  const onError = vi.fn();
  let releaseOld!: (value: TimelineSessionSummary[]) => void;
  let rejectOld!: (reason?: unknown) => void;
  let releaseNew!: (value: TimelineSessionSummary[]) => void;
  vi.mocked(listTimelineSessions)
    .mockImplementationOnce(() => new Promise((resolve, reject) => { releaseOld = resolve; rejectOld = reject; }))
    .mockImplementationOnce(() => new Promise((resolve) => { releaseNew = resolve; }));
  const screen = await renderPwa(<Harness onController={(value) => { controller = value; }} onError={onError} />);
  try {
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf("function"));
    controller!.setDevice("device-b");
    await vi.waitFor(() => expect(releaseNew).toBeTypeOf("function"));
    releaseNew([summary("device-b")]);
    await vi.waitFor(() => expect(screen.getByTestId("history")).toHaveTextContent("device-b"));
    rejectOld(new Error("stale failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});
