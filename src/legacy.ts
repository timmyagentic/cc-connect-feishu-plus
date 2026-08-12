import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LEGACY_MCP_NAME } from "./version.js";

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configuredHome = env.CODEX_HOME?.trim();
  const userHome = env.HOME?.trim() || homedir();
  return join(configuredHome ? resolve(configuredHome) : join(userHome, ".codex"), "config.toml");
}

export function containsLegacyMcpRegistration(text: string): boolean {
  const escaped = LEGACY_MCP_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^\\s*\\[mcp_servers\\.(?:${escaped}|["']${escaped}["'])\\]\\s*$`,
    "m",
  ).test(text);
}

export async function legacyMcpIsConfigured(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    return containsLegacyMcpRegistration(await readFile(codexConfigPath(env), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
