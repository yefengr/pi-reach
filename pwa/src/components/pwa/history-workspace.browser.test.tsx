import { useRef } from "react";
import { expect, test } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { HistoryWorkspace } from "./workspace-content";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";

const items: TimelineViewItem[] = Array.from({ length: 30 }, (_, index) => ({
  kind: "event",
  event: { session_id: "history", leaf_id: "generation", event_id: `e-${index}`, group_id: `g-${index}`, timestamp: index, kind: "assistant", status: "complete", blocks: [{ type: "text", text: `Saved record ${index}` }] },
}));

function Harness({ restoreScrollTop }: { restoreScrollTop: number | null }) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  return <main className="pwa-main" style={{ height: 500, display: "flex", flexDirection: "column" }}>
    <HistoryWorkspace items={items} restoreScrollTop={restoreScrollTop} listRef={listRef} bottomSentinelRef={bottomRef} />
  </main>;
}

test("opens saved history at the latest content the first time and restores the saved position on return", async () => {
  const first = await renderPwa(<Harness restoreScrollTop={null} />);
  const list = document.querySelector<HTMLDivElement>(".pwa-message-list")!;
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  await expect.poll(() => list.scrollHeight - list.clientHeight - list.scrollTop).toBeLessThanOrEqual(1);
  await first.unmount();

  await renderPwa(<Harness restoreScrollTop={120} />);
  const restored = document.querySelector<HTMLDivElement>(".pwa-message-list")!;
  await expect.poll(() => restored.scrollTop).toBe(120);
});
