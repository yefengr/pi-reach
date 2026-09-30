import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const LOCAL_DIR = ".pi/pi-reach";
const LOCAL_FILE = "config.json";

export interface LocalConfig {
  agent_name?: string;
}

function pathFor(cwd: string): string {
  return join(cwd, LOCAL_DIR, LOCAL_FILE);
}

function parseLocalConfig(raw: string): LocalConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const agentName = (parsed as Record<string, unknown>)["agent_name"];
  return typeof agentName === "string" && agentName.trim()
    ? { agent_name: agentName.trim() }
    : {};
}

export function localConfigExists(cwd: string): boolean {
  return existsSync(pathFor(cwd));
}

export function loadLocalConfig(cwd: string): LocalConfig {
  const path = pathFor(cwd);
  if (!existsSync(path)) return {};
  try {
    return parseLocalConfig(readFileSync(path, "utf8")) ?? {};
  } catch {
    return {};
  }
}

export function saveLocalConfig(cwd: string, patch: Partial<LocalConfig>): void {
  const path = pathFor(cwd);
  const next: LocalConfig = { ...loadLocalConfig(cwd), ...patch };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pi-reach] could not persist local config ${path}: ${message}`);
  }
}

export function defaultAgentName(cwd: string): string {
  return basename(cwd) || "agent";
}
