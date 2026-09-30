import { useEffect, useState } from "react";
import { expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { useHistorySessionList } from "./use-history-session-list";
import { listTimelineSessions, type TimelineSessionSummary } from "./timeline-store";

vi.mock("./timeline-store", () => ({ listTimelineSessions: vi.fn() }));

type Controller = { setDevice: (deviceId: string | null) => void };
const summary = (deviceId: string): TimelineSessionSummary => ({
  id: `${deviceId}-session`, deviceId, endpointId: "endpoint", sessionId: "session", leafId: "generation", startedAt: 1, updatedAt: 1, eventCount: 1, preview: "preview",
});

function Harness({ onController, onError }: { onController: (controller: Controller) => void; onError: (message: string) => void }) {
  const [deviceId, setDeviceId] = useState<string | null>("device-a");
  const [sessions, setSessions] = useState<TimelineSessionSummary[]>([]);
  const history = useHistorySessionList({ deviceId, onError, onSessionsLoaded: setSessions });
  useEffect(() => { onController({ setDevice: setDeviceId }); }, [onController]);
  return <output data-testid="history">{history.historySessions.map((session) => session.deviceId).join(",") || sessions.map((session) => session.deviceId).join(",")}</output>;
}

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
