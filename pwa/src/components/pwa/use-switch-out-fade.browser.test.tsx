import { useRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { useSwitchOutFade } from "./use-switch-out-fade";

afterEach(() => { vi.useRealTimers(); });

async function renderFade() {
  let fade!: ReturnType<typeof useSwitchOutFade>;
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    fade = useSwitchOutFade(ref);
    return <div ref={ref} className="switch-target">Old session</div>;
  }
  const screen = await renderPwa(<Harness />);
  return { screen, fade: () => fade, target: document.querySelector<HTMLElement>(".switch-target")! };
}

test("restores the old content when no switch follows the navigation exit", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { screen, fade, target } = await renderFade();
  try {
    fade().begin();
    expect(target.getAnimations()).toHaveLength(1);
    expect((target.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes().at(-1)?.opacity).toBe("0");
    // 拒绝关闭、回弹或没有真正切换时，余量结束后恢复原内容。
    vi.advanceTimersByTime(2000);
    expect(target.getAnimations()).toHaveLength(0);

    fade().begin();
    fade().begin();
    expect(target.getAnimations()).toHaveLength(1);
    fade().settle();
    expect(target.getAnimations()).toHaveLength(0);
  } finally { await screen.unmount(); }
});
