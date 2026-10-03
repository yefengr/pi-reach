import { basename, dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { attachmentStoragePath, localDateDirectory, safeAttachmentFileName } from "./storage-path.js";

const MAX_FILE_NAME_BYTES = 240;

describe("attachment storage paths", () => {
  test("formats the receiving computer's local calendar, not UTC", () => {
    const date = new Date("2026-10-03T00:00:00Z");
    vi.spyOn(date, "getFullYear").mockReturnValue(2026);
    vi.spyOn(date, "getMonth").mockReturnValue(8);
    vi.spyOn(date, "getDate").mockReturnValue(30);
    expect(localDateDirectory(date)).toBe("2026-09-30");
    expect(attachmentStoragePath("/store", "server-id", "原件.txt", date))
      .toBe(join("/store", "2026-09-30", "server-id", "原件.txt"));
  });

  test.each(["原始 照片.jpeg", "report.v1.tar.gz", "一个文件", "a b.c d.txt", "emoji😀.png",
    ".gitignore", ".env", ".reservations", "report..v1.tar.gz", "..合法名称.txt", "_"])(
    "preserves ordinary name %s verbatim", (name) => {
      expect(safeAttachmentFileName(name)).toBe(name);
    },
  );

  test.each(["../secret.env", "..\\..\\secret.txt", "/absolute/file", "C:\\file.txt", "a<>:\"|?*.png",
    "a\u0000b\u001fc\u007fd\u0085e.txt", "evil\u202ename.txt", "..", ".", "", "   ",
    "CON", "con.txt", " PRN.txt", "AUX.tar.gz", "NUL", "COM1.png", "LPT9.txt", "COM¹.txt", "LPT².txt",
    "CONIN$", "CONOUT$.txt", "trailing. "])("sanitizes unsafe name %s into one portable basename", (name) => {
    const safe = safeAttachmentFileName(name);
    expect(safe.length).toBeGreaterThan(0);
    expect(safe).not.toMatch(/[<>:"/\\|?*\p{Cc}\p{Cf}]/u);
    expect(["", ".", ".."]).not.toContain(safe);
    expect(safe).not.toMatch(/[ .]$/u);
    expect(safe.trimStart()).not.toMatch(/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)(?:\.|$)/iu);
    const path = attachmentStoragePath("/store", "server-id", name, new Date(2026, 9, 3));
    expect(dirname(path)).toBe(join("/store", "2026-10-03", "server-id"));
    expect(basename(path)).toBe(safe);
  });

  test.each([`${"长".repeat(100)}.jpeg`, `${"😀".repeat(100)}.tar.gz`, `${"n".repeat(400)}.txt`])(
    "limits UTF-8 bytes without splitting codepoints while preserving extension", (name) => {
      const safe = safeAttachmentFileName(name);
      expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
      expect(safe).not.toContain("\ufffd");
      expect(Buffer.from(safe).toString("utf8")).toBe(safe);
      expect(safe.endsWith(name.slice(name.lastIndexOf(".")))).toBe(true);
    },
  );

  test.each([`${" ".repeat(240)}x`, `${"a".repeat(239)} z`, `CON中.${"x".repeat(235)}`])(
    "does not introduce trailing spaces or device names by truncation", (name) => {
      const safe = safeAttachmentFileName(name);
      expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
      expect(safe).not.toMatch(/^[.]|[ .]$/u);
      expect(safe.trimStart()).not.toMatch(/^CON(?:\.|$)/iu);
      expect(safe.trim()).not.toBe("");
    },
  );

  test("bounds an exceptionally long extension as well as an extensionless name", () => {
    for (const name of [`x.${"长".repeat(300)}`, "长".repeat(300), `${"😀".repeat(100)}.${"😀".repeat(100)}`]) {
      const safe = safeAttachmentFileName(name);
      expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
      expect(safe).not.toContain("\ufffd");
      expect(Buffer.from(safe).toString("utf8")).toBe(safe);
    }
  });
});
