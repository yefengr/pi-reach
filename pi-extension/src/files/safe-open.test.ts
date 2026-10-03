import { constants, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileAccessError, openSourceFile } from "./safe-open.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
const supported = ["darwin", "linux"].includes(process.platform);
const options = { resolveLinks: false, maxBytes: 1024 };
const realOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
let directory: string;
let source: string;

beforeEach(async () => {
  vi.mocked(fs.open).mockReset().mockImplementation(realOpen);
  directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "pi-reach-safe-open-")));
  source = join(directory, "中文 file.txt");
  await fs.writeFile(source, "original");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe.skipIf(!supported)("openSourceFile", () => {
  it("opens ordinary, empty and project-external files without changing content or permissions", async () => {
    const before = await fs.stat(source, { bigint: true });
    const result = await openSourceFile(source, options);
    expect(result.path).toBe(source);
    expect(result.stat.size).toBe(8n);
    await result.handle.close();
    expect(await fs.readFile(source, "utf8")).toBe("original");
    const after = await fs.stat(source, { bigint: true });
    expect(after.mode).toBe(before.mode);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    await fs.writeFile(source, "");
    const empty = await openSourceFile(source, { ...options, maxBytes: 0 });
    expect(empty.stat.size).toBe(0n);
    await empty.handle.close();
  });

  it("resolves publication links/relative paths but rejects noncanonical retrieval paths", async () => {
    const link = join(directory, "link");
    await fs.symlink(source, link);
    const opened = await openSourceFile(relative(process.cwd(), link), { ...options, resolveLinks: true });
    expect(opened.path).toBe(source);
    await opened.handle.close();
    for (const path of [link, relative(process.cwd(), source), `${directory}/./中文 file.txt`]) {
      await expect(openSourceFile(path, options)).rejects.toMatchObject({ code: "file_changed" });
    }
    const parentLink = join(directory, "parent-link");
    await fs.symlink(directory, parentLink);
    await expect(openSourceFile(join(parentLink, "中文 file.txt"), options)).rejects.toMatchObject({ code: "file_changed" });
  });

  it("rejects missing paths, directories, oversize files and invalid limits", async () => {
    await expect(openSourceFile(join(directory, "missing"), options)).rejects.toMatchObject({ code: "not_available" });
    await expect(openSourceFile(directory, options)).rejects.toMatchObject({ code: "not_regular_file" });
    await expect(openSourceFile(source, { ...options, maxBytes: 7 })).rejects.toMatchObject({ code: "too_large" });
    for (const maxBytes of [-1, NaN, Infinity, 1.1]) {
      await expect(openSourceFile(source, { ...options, maxBytes })).rejects.toMatchObject({ code: "io_error" });
    }
    const exact = await openSourceFile(source, { ...options, maxBytes: 8 });
    await exact.handle.close();
  });

  it("maps access denial (root may legitimately bypass fixture permissions)", async () => {
    await fs.chmod(source, 0);
    try {
      if (process.geteuid?.() === 0) {
        const result = await openSourceFile(source, options);
        await result.handle.close();
      } else {
        await expect(openSourceFile(source, options)).rejects.toMatchObject({ code: "permission_denied" });
      }
    } finally { await fs.chmod(source, 0o600); }
    vi.mocked(fs.open).mockRejectedValueOnce(Object.assign(new Error("private path"), { code: "EACCES" }));
    await expect(openSourceFile(source, options)).rejects.toMatchObject({ code: "permission_denied", message: "permission_denied" });
  });

  it("rejects a last-component symlink introduced immediately before open", async () => {
    vi.mocked(fs.open).mockImplementationOnce(async (path, flags) => {
      await fs.rename(source, `${source}.old`);
      await fs.symlink(`${source}.old`, source);
      return realOpen(path, flags);
    });
    await expect(openSourceFile(source, options)).rejects.toMatchObject({ code: "file_changed" });
  });

  it("rejects parent-directory redirection and closes the actual opened handle", async () => {
    const parent = join(directory, "parent");
    const target = join(directory, "target");
    await fs.mkdir(parent);
    await fs.mkdir(target);
    const path = join(parent, "file");
    await fs.writeFile(path, "original");
    await fs.writeFile(join(target, "file"), "redirect");
    let actual: FileHandle | undefined;
    vi.mocked(fs.open).mockImplementationOnce(async (input, flags) => {
      await fs.rename(parent, `${parent}.old`);
      await fs.symlink(target, parent);
      actual = await realOpen(input, flags);
      return actual;
    });
    await expect(openSourceFile(path, options)).rejects.toMatchObject({ code: "file_changed" });
    expect(actual).toBeDefined();
    await expect(actual!.stat()).rejects.toMatchObject({ code: "EBADF" });
  });

  it("rejects a replacement parent directory even if it contains the same source inode", async () => {
    const parent = join(directory, "parent");
    const replacement = join(directory, "replacement");
    await fs.mkdir(parent);
    await fs.mkdir(replacement);
    const path = join(parent, "file");
    await fs.writeFile(path, "original");
    await fs.link(path, join(replacement, "file"));
    let actual: FileHandle | undefined;
    vi.mocked(fs.open).mockImplementationOnce(async (input, flags) => {
      await fs.rename(parent, `${parent}.old`);
      await fs.rename(replacement, parent);
      actual = await realOpen(input, flags);
      return actual;
    });
    await expect(openSourceFile(path, options)).rejects.toMatchObject({ code: "file_changed" });
    await expect(actual!.stat()).rejects.toMatchObject({ code: "EBADF" });
  });

  it("rejects a same-sized replacement inode after open", async () => {
    let actual: FileHandle | undefined;
    vi.mocked(fs.open).mockImplementationOnce(async (path, flags) => {
      actual = await realOpen(path, flags);
      await fs.rename(source, `${source}.old`);
      await fs.writeFile(source, "original");
      return actual;
    });
    await expect(openSourceFile(source, options)).rejects.toMatchObject({ code: "file_changed" });
    await expect(actual!.stat()).rejects.toMatchObject({ code: "EBADF" });
  });

  it("rejects identity/content changes after open and closes before returning failure", async () => {
    let actual: FileHandle | undefined;
    vi.mocked(fs.open).mockImplementationOnce(async (path, flags) => {
      actual = await realOpen(path, flags);
      await fs.writeFile(source, "changed-length");
      return actual;
    });
    await expect(openSourceFile(source, options)).rejects.toMatchObject({ code: "file_changed" });
    await expect(actual!.stat()).rejects.toMatchObject({ code: "EBADF" });
  });

  it("returns an owned, genuinely open handle if failure cleanup itself fails", async () => {
    let actual: FileHandle | undefined;
    vi.mocked(fs.open).mockImplementationOnce(async (path, flags) => {
      actual = await realOpen(path, flags);
      await fs.writeFile(source, "changed-length");
      vi.spyOn(actual, "close").mockRejectedValueOnce(new Error("close failure"));
      return actual;
    });
    const failure = await openSourceFile(source, options).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FileAccessError);
    expect(failure).toMatchObject({ code: "file_changed", handle: actual, closeError: expect.any(Error) });
    expect((await actual!.stat()).isFile()).toBe(true);
    await (failure as FileAccessError).handle!.close();
    await expect(actual!.stat()).rejects.toMatchObject({ code: "EBADF" });
  });

  it.skipIf(!existsSync("/usr/bin/mkfifo"))("rejects an existing FIFO and cannot block on a FIFO replacement race", async () => {
    const fifo = join(directory, "pipe");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    await expect(openSourceFile(fifo, options)).rejects.toMatchObject({ code: "not_regular_file" });
    let actual: FileHandle | undefined;
    vi.mocked(fs.open).mockImplementationOnce(async (path, flags) => {
      expect(Number(flags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      expect(Number(flags) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      await fs.rename(source, `${source}.old`);
      await fs.rename(fifo, source);
      actual = await realOpen(path, flags);
      return actual;
    });
    await expect(openSourceFile(source, options)).rejects.toMatchObject({ code: "not_regular_file" });
    await expect(actual!.stat()).rejects.toMatchObject({ code: "EBADF" });
  });
});

it.skipIf(supported)("fails closed on unsupported platforms", async () => {
  await expect(openSourceFile(source, options)).rejects.toMatchObject({ code: "not_available" });
});
