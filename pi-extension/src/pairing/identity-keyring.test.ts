import { afterEach, describe, expect, test, vi } from "vitest";
import {
  _runKeyringOperationWithTimeoutForTest,
  KeyringMutationTimeoutError,
  KeyringReadTimeoutError,
} from "./identity-keyring.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("keyring operation timeout", () => {
  test("clears the timeout timer when the operation succeeds", async () => {
    vi.useFakeTimers();
    await expect(_runKeyringOperationWithTimeoutForTest(
      Promise.resolve("ok"),
      "read(test)",
      false,
      100,
    )).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("read timeout is retryable and does not expose mutation settlement", async () => {
    vi.useFakeTimers();
    const operation = deferred<string>();
    const result = _runKeyringOperationWithTimeoutForTest(
      operation.promise,
      "read(test)",
      false,
      10,
    );
    const assertion = expect(result).rejects.toBeInstanceOf(KeyringReadTimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    operation.resolve("late");
    await vi.runAllTimersAsync();
  });

  test("mutation timeout reports promptly while retaining a handled settled promise", async () => {
    vi.useFakeTimers();
    const operation = deferred<void>();
    const result = _runKeyringOperationWithTimeoutForTest(
      operation.promise,
      "write(test)",
      true,
      10,
    );
    const assertion = expect(result).rejects.toBeInstanceOf(KeyringMutationTimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;

    operation.reject(new Error("late native rejection"));
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });
});
