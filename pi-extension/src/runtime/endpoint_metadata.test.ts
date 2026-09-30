import { describe, expect, test } from "vitest";
import { currentSessionName, UNTITLED_SESSION_NAME } from "./endpoint_metadata.js";

describe("currentSessionName", () => {
  test("trims the current Pi session name", () => {
    expect(currentSessionName({ getSessionName: () => "  Release notes  " })).toBe("Release notes");
  });

  test("uses the exact fallback for missing or empty names", () => {
    expect(currentSessionName({ getSessionName: () => undefined })).toBe(UNTITLED_SESSION_NAME);
    expect(currentSessionName({ getSessionName: () => "  " })).toBe(UNTITLED_SESSION_NAME);
  });
});
