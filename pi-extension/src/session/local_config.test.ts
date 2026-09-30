import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalConfig, localConfigExists, saveLocalConfig } from "./local_config.js";

function makeCwd(): string {
  return mkdtempSync(join(tmpdir(), "rp-localcfg-"));
}

function writeFileConfig(cwd: string, obj: unknown): void {
  const dir = join(cwd, ".pi", "pi-reach");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
}

describe("local endpoint display config", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeCwd();
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("reads the optional display name from disk", () => {
    writeFileConfig(cwd, { agent_name: "fromfile" });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromfile" });
  });

  test("ignores stale endpoint lifecycle fields", () => {
    writeFileConfig(cwd, { agent_name: "app", workspace: "acme" });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "app" });
  });

  test("reports whether a local display config exists", () => {
    expect(localConfigExists(cwd)).toBe(false);
    writeFileConfig(cwd, { agent_name: "app" });
    expect(localConfigExists(cwd)).toBe(true);
  });

  test("persists only the supplied display configuration", () => {
    saveLocalConfig(cwd, { agent_name: "saved" });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "saved" });
  });
});
