import { createHash } from "node:crypto";
import { userContentBlocks } from "./attachment_content.js";
import type { Correlation } from "./runtime.js";

/** 与投递队列容量一致：同一时刻最多这么多条排队消息可能被插入。 */
const MAX_EXPECTED_STEERS = 32;

type ExpectedSteer = { key: string; correlation: Correlation };

function contentKey(content: unknown): string {
  return createHash("sha256").update(JSON.stringify(userContentBlocks(content))).digest("hex");
}

/**
 * steer 只把消息放进 SDK 的 steering 队列，message_start 在本轮下一个边界才发出，
 * 此时 ALS 仍是发起本轮的请求；按内容先进先出取回插入时登记的关联，与 SDK 的投递顺序一致。
 */
export class SteerCorrelations {
  private expected: ExpectedSteer[] = [];

  expect(content: unknown, correlation: Correlation): void {
    this.expected.push({ key: contentKey(content), correlation: { ...correlation } });
    // 被中止的运行可能留下从未开始的登记；超出上限时淘汰最早的，避免无界增长。
    if (this.expected.length > MAX_EXPECTED_STEERS) this.expected.shift();
  }

  take(content: unknown): Correlation | undefined {
    if (this.expected.length === 0) return undefined;
    const key = contentKey(content);
    const index = this.expected.findIndex((entry) => entry.key === key);
    if (index < 0) return undefined;
    const [entry] = this.expected.splice(index, 1);
    return { ...entry!.correlation };
  }

  clear(): void {
    this.expected = [];
  }
}
