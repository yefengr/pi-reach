import { createHash } from "node:crypto";
import { userContentBlocks } from "./attachment_content.js";
import type { Correlation } from "./runtime.js";

/**
 * 尚未开始的插入上限。steer 调用 SDK 后即释放投递队列容量，队列上限不能约束该数量，
 * 由调用方在投递前用 hasCapacity 拒绝，而不是淘汰仍有效的登记。
 */
export const MAX_EXPECTED_STEERS = 32;

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

  hasCapacity(): boolean {
    return this.expected.length < MAX_EXPECTED_STEERS;
  }

  /** 已满时不登记并返回 false：调用方须先检查 hasCapacity，不能淘汰仍在等待开始的插入。 */
  expect(content: unknown, correlation: Correlation): boolean {
    if (!this.hasCapacity()) return false;
    // 保留原对象以便按身份撤销；取出时再复制。
    this.expected.push({ key: contentKey(content), correlation });
    return true;
  }

  take(content: unknown): Correlation | undefined {
    if (this.expected.length === 0) return undefined;
    const key = contentKey(content);
    const index = this.expected.findIndex((entry) => entry.key === key);
    if (index < 0) return undefined;
    const [entry] = this.expected.splice(index, 1);
    return { ...entry!.correlation };
  }

  /** 撤销某次请求的登记：已在自身 ALS 内开始或 SDK 同步抛错时，不再参与内容匹配。 */
  discard(correlation: Correlation): void {
    this.expected = this.expected.filter((entry) => entry.correlation !== correlation);
  }

  clear(): void {
    this.expected = [];
  }
}
