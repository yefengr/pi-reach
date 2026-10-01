import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});

afterEach(() => {
  vi.mocked(readFileSync).mockClear();
  vi.resetModules();
});

describe("Relay package version", () => {
  it("reads the actual package once at module initialization", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    vi.mocked(readFileSync).mockClear();
    const first = await import("./version.js");
    const second = await import("./version.js");
    expect(first.RELAY_VERSION).toBe(pkg.version);
    expect(second.RELAY_VERSION).toBe(pkg.version);
    expect(readFileSync).toHaveBeenCalledExactlyOnceWith(new URL("../package.json", import.meta.url), "utf8");
  });

  it.each([undefined, null, "", 1, "v".repeat(257)])("rejects an invalid installed package version (%s)", async (version) => {
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ version }));
    await expect(import("./version.js")).rejects.toThrow("Pi Reach Relay package has an invalid version");
  });

  it("does not replace an unreadable package with a fabricated version", async () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw new Error("package unavailable"); });
    await expect(import("./version.js")).rejects.toThrow("package unavailable");
  });
});
