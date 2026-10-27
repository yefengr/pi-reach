import { useCallback, useRef } from "react";
import { expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { AUTO_LOAD_EARLIER_SCREENS, AUTO_LOAD_EARLIER_THRESHOLD_PX, useAutoLoadEarlier } from "./use-auto-load-earlier";

type Geometry = { clientHeight: number; scrollTop: number };

/** 在节点挂载时就固定几何，挂载后首帧的判断即读取这组数值。 */
function AutoLoadHarness({ geometry, screens, onLoad }: { geometry: Geometry; screens: number; onLoad: () => void }) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const attach = useCallback((list: HTMLDivElement | null) => {
    if (list) Object.defineProperties(list, {
      clientHeight: { configurable: true, value: geometry.clientHeight },
      scrollHeight: { configurable: true, value: geometry.clientHeight * 10 },
      scrollTop: { configurable: true, writable: true, value: geometry.scrollTop },
    });
    listRef.current = list;
  }, [geometry]);
  useAutoLoadEarlier({ listRef, enabled: true, contentVersion: 0, lookaheadScreens: screens, onLoad });
  return <div ref={attach} />;
}

async function loadsAt(clientHeight: number, scrollTop: number, screens = AUTO_LOAD_EARLIER_SCREENS): Promise<boolean> {
  const onLoad = vi.fn();
  const screen = await renderPwa(<AutoLoadHarness geometry={{ clientHeight, scrollTop }} screens={screens} onLoad={onLoad} />);
  try {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return onLoad.mock.calls.length > 0;
  } finally { await screen.unmount(); }
}

test("live sessions load earlier records two screens before the top on tall viewports", async () => {
  expect(await loadsAt(600, 1200)).toBe(true);
  expect(await loadsAt(600, 1201)).toBe(false);
});

test("keeps the minimum distance on short viewports", async () => {
  expect(await loadsAt(100, AUTO_LOAD_EARLIER_THRESHOLD_PX)).toBe(true);
  expect(await loadsAt(100, AUTO_LOAD_EARLIER_THRESHOLD_PX + 1)).toBe(false);
});

test("local history without lookahead keeps the minimum distance on tall viewports", async () => {
  expect(await loadsAt(600, AUTO_LOAD_EARLIER_THRESHOLD_PX, 0)).toBe(true);
  expect(await loadsAt(600, AUTO_LOAD_EARLIER_THRESHOLD_PX + 1, 0)).toBe(false);
});
