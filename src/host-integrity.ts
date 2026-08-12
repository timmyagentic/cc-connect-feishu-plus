import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface HostBinaryIdentity {
  path: string;
  sha256: string;
  version?: string;
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

async function fromLaunchAgent(home: string): Promise<string | undefined> {
  try {
    const plist = await readFile(
      join(home, "Library", "LaunchAgents", "com.cc-connect.service.plist"),
      "utf8",
    );
    const match = plist.match(
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>([\s\S]*?)<\/string>/,
    );
    return match?.[1] ? decodeXml(match[1].trim()) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function fromPath(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "cc-connect");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking without invoking a shell or following an alias.
    }
  }
  return undefined;
}

export async function discoverHostBinary(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostBinaryIdentity | undefined> {
  const explicit = env.CC_CONNECT_BINARY?.trim();
  const path = explicit || (await fromLaunchAgent(env.HOME ?? "")) || (await fromPath(env));
  if (!path) return undefined;
  let version: string | undefined;
  try {
    const result = await execFileAsync(path, ["--version"], { timeout: 5_000, env });
    version = `${result.stdout}\n${result.stderr}`.match(
      /cc-connect\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i,
    )?.[1];
  } catch {
    // The hash remains useful to doctor; install performs the compatibility gate.
  }
  return { path, sha256: await sha256File(path), ...(version ? { version } : {}) };
}

function versionParts(version: string): [number, number, number] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`invalid semantic version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const current = versionParts(version);
  const required = versionParts(minimum);
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]! > required[index]!) return true;
    if (current[index]! < required[index]!) return false;
  }
  return true;
}
