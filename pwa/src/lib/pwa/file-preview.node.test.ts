import { describe, expect, test } from "vitest";
import { FILE_TEXT_PREVIEW_BYTES, FILE_TEXT_RENDER_CHARACTERS, fileSaveName, safeFileLink, textFilePreview } from "./file-preview";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("published file text boundaries", () => {
  test("empty, Unicode, and invalid binary", () => {
    expect(textFilePreview(utf8(""))).toEqual({ text: "", truncated: false });
    expect(textFilePreview(utf8("你好😀\n文本\t内容"))).toEqual({ text: "你好😀\n文本\t内容", truncated: false });
    expect(textFilePreview(Uint8Array.of(0xff))).toBeNull();
    expect(textFilePreview(utf8("abc\0xyz"))).toBeNull();
  });
  test("a byte-truncated UTF-8 tail never creates replacement characters", () => {
    const bytes = utf8("a".repeat(FILE_TEXT_PREVIEW_BYTES - 1) + "😀尾部");
    const result = textFilePreview(bytes);
    expect(result?.truncated).toBe(true);
    expect(result?.text).not.toContain("�");
    expect(result?.text.length).toBe(FILE_TEXT_RENDER_CHARACTERS);
  });
  test("DOM workload is bounded by both lines and characters", () => {
    expect(textFilePreview(utf8("x\n".repeat(2000)))?.text.split("\n")).toHaveLength(1000);
    const result = textFilePreview(utf8("a".repeat(FILE_TEXT_RENDER_CHARACTERS - 1) + "😀"));
    expect(result?.text.endsWith("\ud83d")).toBe(false);
    expect(result?.truncated).toBe(true);
  });
  test("only absolute HTTP(S) links are active", () => {
    expect(safeFileLink("https://example.test/a")).toBe("https://example.test/a");
    for (const link of ["javascript:alert(1)", "data:text/html,x", "file:///tmp/x", "/local", "../picture.png", "//remote.test/a", "mailto:x@y.test"]) expect(safeFileLink(link)).toBeUndefined();
  });
  test("save names preserve ordinary Unicode without allowing path components", () => {
    expect(fileSaveName("效果图 v1.png")).toBe("效果图 v1.png");
    expect(fileSaveName("../../CON.txt\0")).toBe(".._.._CON.txt_");
    expect(fileSaveName("CON.txt")).toBe("_CON.txt");
    expect(fileSaveName("... ")).toBe("file");
  });
});
