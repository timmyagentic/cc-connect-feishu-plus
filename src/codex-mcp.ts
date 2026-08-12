import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { MCP_NAME } from "./version.js";

export const CODEX_CONTEXT_ENV_VARS = ["CC_PROJECT", "CC_SESSION_KEY"] as const;

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configuredHome = env.CODEX_HOME?.trim();
  const userHome = env.HOME?.trim() || homedir();
  return join(configuredHome ? resolve(configuredHome) : join(userHome, ".codex"), "config.toml");
}

function contextEnvValues(text: string, serverName: string): unknown {
  const root = record(parse(text));
  const servers = record(root.mcp_servers);
  return record(servers[serverName]).env_vars;
}

export function hasCodexMcpContextEnv(
  text: string,
  serverName = MCP_NAME,
): boolean {
  try {
    const values = contextEnvValues(text, serverName);
    return (
      Array.isArray(values) &&
      CODEX_CONTEXT_ENV_VARS.every((name) => values.includes(name))
    );
  } catch {
    return false;
  }
}

function isServerHeader(line: string, serverName: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === `[mcp_servers.${serverName}]` ||
    trimmed === `[mcp_servers.${JSON.stringify(serverName)}]`
  );
}

export function renderCodexMcpContextEnv(
  text: string,
  serverName = MCP_NAME,
): string {
  if (hasCodexMcpContextEnv(text, serverName)) return text;

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = text.endsWith("\n");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (hadFinalNewline) lines.pop();

  const start = lines.findIndex((line) => isServerHeader(line, serverName));
  if (start < 0) {
    throw new Error(`mcp_servers.${serverName} was not found after registration`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }

  const existingValues = contextEnvValues(text, serverName);
  const keyIndex = lines.findIndex(
    (line, index) =>
      index > start && index < end && /^\s*env_vars\s*=/.test(line),
  );
  if (keyIndex >= 0) {
    if (!Array.isArray(existingValues)) {
      throw new Error(`mcp_servers.${serverName}.env_vars is not an array`);
    }
    if (!(lines[keyIndex] ?? "").includes("]")) {
      throw new Error(
        `mcp_servers.${serverName}.env_vars uses an unsupported multiline array`,
      );
    }
    const merged = [
      ...existingValues.filter((value): value is string => typeof value === "string"),
      ...CODEX_CONTEXT_ENV_VARS.filter((name) => !existingValues.includes(name)),
    ];
    const indent = lines[keyIndex]?.match(/^\s*/)?.[0] ?? "";
    lines[keyIndex] = `${indent}env_vars = ${tomlStringArray(merged)}`;
  } else {
    let insertAt = end;
    while (insertAt > start + 1 && lines[insertAt - 1]?.trim() === "") {
      insertAt -= 1;
    }
    lines.splice(
      insertAt,
      0,
      `env_vars = ${tomlStringArray([...CODEX_CONTEXT_ENV_VARS])}`,
    );
  }

  const rendered = `${lines.join(newline)}${hadFinalNewline ? newline : ""}`;
  if (!hasCodexMcpContextEnv(rendered, serverName)) {
    throw new Error(`failed to configure mcp_servers.${serverName}.env_vars`);
  }
  return rendered;
}

export async function configureCodexMcpContextEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string; changed: boolean }> {
  const path = codexConfigPath(env);
  const original = await readFile(path, "utf8");
  const rendered = renderCodexMcpContextEnv(original);
  if (rendered === original) return { path, changed: false };

  const mode = (await stat(path)).mode & 0o777;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, rendered, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
  return { path, changed: true };
}

export async function codexMcpContextEnvIsConfigured(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    return hasCodexMcpContextEnv(await readFile(codexConfigPath(env), "utf8"));
  } catch {
    return false;
  }
}
