import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { act } from "react";
import { useDelayedVisibility } from "./workspace-content";

function Probe({ active, delay, minimum }: { active: boolean; delay?: number; minimum?: number }) {
  return <span data-testid="probe">{useDelayedVisibility(active, delay, minimum) ? "shown" : "hidden"}</span>;
}

afterEach(() => { vi.useRealTimers(); });

test("shows a loading state only after 300ms and keeps it for at least 500ms", async () => {
  vi.useFakeTimers();
  const screen = await render(<Probe active />);
  const probe = screen.getByTestId("probe");
  await act(async () => { vi.advanceTimersByTime(299); });
  expect(probe.element().textContent).toBe("hidden");
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(probe.element().textContent).toBe("shown");

  await screen.rerender(<Probe active={false} />);
  await act(async () => { vi.advanceTimersByTime(499); });
  expect(probe.element().textContent).toBe("shown");
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(probe.element().textContent).toBe("hidden");
});

test("never shows work that finishes within the delay, and waits 10 seconds for the connection banner", async () => {
  vi.useFakeTimers();
  const screen = await render(<Probe active />);
  const probe = screen.getByTestId("probe");
  await act(async () => { vi.advanceTimersByTime(200); });
  await screen.rerender(<Probe active={false} />);
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(probe.element().textContent).toBe("hidden");

  await screen.rerender(<Probe active delay={10_000} minimum={0} />);
  await act(async () => { vi.advanceTimersByTime(9_999); });
  expect(probe.element().textContent).toBe("hidden");
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(probe.element().textContent).toBe("shown");
  await screen.rerender(<Probe active={false} delay={10_000} minimum={0} />);
  await act(async () => { vi.advanceTimersByTime(0); });
  expect(probe.element().textContent).toBe("hidden");
});
