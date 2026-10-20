import { expect, test } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { animatePublishedImage, publishedImageBounds, type ImageBounds } from "./published-image-motion";
import "./published-files.css";

// 暂停并定位动画时钟，不等待长动画；留出慢机器上的断言窗口，避免清理兜底先到期。
const DURATION = 10_000;

async function imageFixture() {
  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 300;
  const url = canvas.toDataURL("image/png");
  const screen = await renderPwa(<>
    <div data-publication-id="radius-fixture">
      <button className="pwa-published-image" type="button" style={{ position: "fixed", left: 20, top: 20, width: 200, height: 150 }}>
        <img src={url} alt="Source fixture" />
      </button>
    </div>
    <div className="pwa-file-image-stage" data-publication-id="radius-fixture" style={{ position: "fixed", left: 500, top: 40, width: 440, height: 340 }}>
      <img src={url} alt="Target fixture" />
    </div>
  </>);
  const source = document.querySelector<HTMLButtonElement>(".pwa-published-image")!;
  const root = document.querySelector<HTMLElement>(".pwa-file-image-stage")!;
  const image = root.querySelector("img")!;
  await expect.poll(() => [source.querySelector("img")!, image].every(node => node.complete && node.naturalWidth > 0)).toBe(true);
  const small = publishedImageBounds(source.querySelector("img"))!;
  const large = publishedImageBounds(image, false)!;
  expect(Math.round(large.width / small.width)).toBe(2);
  return { screen, source, root, image, sourceUrl: image.currentSrc, small, large };
}

function roundedBounds(bounds: ImageBounds) {
  return [bounds.left, bounds.top, bounds.width, bounds.height].map(Math.round);
}

/** CSS 圆角是变换前的值；屏幕半径还必须乘上横纵实际缩放比例。 */
function expectScreenRadius(image: HTMLImageElement) {
  const style = getComputedStyle(image);
  const bounds = image.getBoundingClientRect();
  const scaleX = bounds.width / parseFloat(style.width);
  const scaleY = bounds.height / parseFloat(style.height);
  for (const corner of [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]) {
    const [x, y = x] = corner.split(" ").map(parseFloat);
    // 夹具每一边均大于直径，浏览器不会触发过大圆角的自动收缩。
    expect(Math.round(x * scaleX)).toBe(8);
    expect(Math.round(y * scaleY)).toBe(8);
  }
}

function sample(image: HTMLImageElement, start: ImageBounds, end: ImageBounds) {
  const animation = image.getAnimations()[0];
  animation.pause();
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    animation.currentTime = DURATION * progress;
    expectScreenRadius(image);
    const bounds = image.getBoundingClientRect();
    if (progress === 0) expect(roundedBounds(bounds)).toEqual(roundedBounds(start));
    if (progress === 1) expect(roundedBounds(bounds)).toEqual(roundedBounds(end));
  }
}

test.each(["in", "out"] as const)("image %s keeps all four screen-space radii at 8px throughout its geometry change", async direction => {
  const fixture = await imageFixture();
  const motion = animatePublishedImage({ ...fixture, direction, duration: DURATION });
  try {
    expect(motion).not.toBeNull();
    const clone = document.querySelector<HTMLImageElement>(".pwa-published-image-transition")!;
    sample(clone, direction === "in" ? fixture.small : fixture.large, direction === "in" ? fixture.large : fixture.small);
  } finally {
    motion?.cancel();
    expect(fixture.source.querySelector("img")!.style.visibility).toBe("");
    expect(fixture.image.style.visibility).toBe("");
    await fixture.screen.unmount();
  }
});

test("a reversed image starts at its current bounds without changing the screen-space radius", async () => {
  const fixture = await imageFixture();
  const entering = animatePublishedImage({ ...fixture, direction: "in", duration: DURATION });
  let exiting: ReturnType<typeof animatePublishedImage> = null;
  try {
    expect(entering).not.toBeNull();
    const first = document.querySelector<HTMLImageElement>(".pwa-published-image-transition")!;
    const animation = first.getAnimations()[0];
    animation.pause();
    animation.currentTime = DURATION * 0.4;
    const from = entering!.bounds()!;
    expectScreenRadius(first);
    entering!.cancel();
    exiting = animatePublishedImage({ ...fixture, direction: "out", duration: DURATION, from });
    expect(exiting).not.toBeNull();
    const second = document.querySelector<HTMLImageElement>(".pwa-published-image-transition")!;
    sample(second, from, fixture.small);
    expect(document.querySelectorAll(".pwa-published-image-transition")).toHaveLength(1);
  } finally {
    entering?.cancel();
    exiting?.cancel();
    await fixture.screen.unmount();
  }
});

test("different horizontal and vertical handoff ratios do not turn circular corners into ellipses", async () => {
  const fixture = await imageFixture();
  const from = { left: 250, top: 120, width: 180, height: 90 };
  const motion = animatePublishedImage({ ...fixture, direction: "out", duration: DURATION, from });
  try {
    expect(motion).not.toBeNull();
    sample(document.querySelector<HTMLImageElement>(".pwa-published-image-transition")!, from, fixture.small);
  } finally {
    motion?.cancel();
    await fixture.screen.unmount();
  }
});
