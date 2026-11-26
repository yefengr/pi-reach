import { afterEach, expect, test } from "vitest";
import { cdp } from "vitest/browser";
import { usePwaMotionDuration } from "@yefengr/pwa-foundation";
import { renderPwa } from "@/test/browser/render";

const motion = (reduce: boolean) => cdp().send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }],
});
afterEach(async () => { await cdp().send("Emulation.setEmulatedMedia", { features: [] }); });

test("installed shared hook immediately follows system motion changes without remounting", async () => {
  await motion(false);
  function Values() {
    const drawer = usePwaMotionDuration("--pwa-duration-drawer");
    const modal = usePwaMotionDuration("--pwa-duration-modal-in");
    return <output data-testid="durations">{drawer}/{modal}</output>;
  }
  const screen = await renderPwa(<Values />);
  try {
    const node = screen.getByTestId("durations").element();
    await expect.poll(() => node.textContent).toBe("360/400");
    await motion(true);
    await expect.poll(() => node.textContent).toBe("120/120");
    await motion(false);
    await expect.poll(() => node.textContent).toBe("360/400");
    expect(screen.getByTestId("durations").element()).toBe(node);
  } finally { await screen.unmount(); }
});
