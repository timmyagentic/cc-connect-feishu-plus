import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderConfigForInstall } from "./config.js";
import {
  discoverHostBinary,
  sha256File,
  versionAtLeast,
} from "./host-integrity.js";
import { legacyMcpIsConfigured } from "./legacy.js";
import {
  configPath as defaultConfigPath,
  manifestPath,
  pluginDataDir,
  runtimeExecutablePath,
} from "./paths.js";
import type { InstallManifest, InstalledProject } from "./types.js";
import {
  MINIMUM_CC_CONNECT_VERSION,
  PACKAGE_VERSION,
} from "./version.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function atomicWrite(path: string, data: string | Buffer, mode: number): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, data, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

function bundledRuntimeSource(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "runtime", "codex-proxy.mjs");
}

type UnknownManifest = Partial<InstallManifest> & { version?: number };

async function readUnknownManifest(
  env: NodeJS.ProcessEnv,
): Promise<UnknownManifest | undefined> {
  try {
    return JSON.parse(await readFile(manifestPath(env), "utf8")) as UnknownManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function requireCurrentManifest(value: UnknownManifest): InstallManifest {
  if (value.version !== 2) {
    throw new Error(
      "a legacy Feishu Plus MCP installation is still recorded; uninstall v0.1.2 before installing v0.2.0",
    );
  }
  return value as InstallManifest;
}

async function installRuntime(source: string, target: string): Promise<string> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await chmod(dirname(target), 0o700);
  const temporary = `${target}.${process.pid}.tmp`;
  await copyFile(source, temporary);
  await chmod(temporary, 0o700);
  await rename(temporary, target);
  return sha256File(target);
}

export interface InstallOptions {
  configPath?: string;
  projectNames?: string[];
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  nodeExecutablePath?: string;
  runtimeSourcePath?: string;
  legacyMcpConfigured?: typeof legacyMcpIsConfigured;
}

export interface InstallResult {
  changed: boolean;
  dryRun: boolean;
  configPath: string;
  projects: InstalledProject[];
  agents: Array<"codex">;
  nodeExecutablePath: string;
  runtimeExecutablePath: string;
  hostBinary?: { path: string; sha256: string; unchanged: boolean };
  backupPath?: string;
}

export async function install(options: InstallOptions = {}): Promise<InstallResult> {
  const env = options.env ?? process.env;
  const path = options.configPath ?? defaultConfigPath(env);
  const nodeExecutablePath = options.nodeExecutablePath ?? process.execPath;
  const runtimeTarget = runtimeExecutablePath(PACKAGE_VERSION, env);
  const runtimeSource = options.runtimeSourcePath ?? bundledRuntimeSource();
  const legacyCheck = options.legacyMcpConfigured ?? legacyMcpIsConfigured;
  const original = await readFile(path);
  const originalText = original.toString("utf8");
  const rendered = renderConfigForInstall(
    originalText,
    {
      nodeExecutablePath,
      runtimeExecutablePath: runtimeTarget,
      configPath: path,
      ...(options.projectNames ? { projectNames: options.projectNames } : {}),
    },
    env,
  );
  const sourceRuntimeHash = await sha256File(runtimeSource);

  const hostBefore = await discoverHostBinary(env);
  if (!hostBefore) {
    throw new Error(
      "official CC Connect binary was not found; set CC_CONNECT_BINARY to verify compatibility",
    );
  }
  if (
    !hostBefore.version ||
    !versionAtLeast(hostBefore.version, MINIMUM_CC_CONNECT_VERSION)
  ) {
    throw new Error(
      `CC Connect ${MINIMUM_CC_CONNECT_VERSION} or newer is required (found ${hostBefore.version ?? "unknown"})`,
    );
  }

  const unknownManifest = await readUnknownManifest(env);
  if (unknownManifest) {
    const existing = requireCurrentManifest(unknownManifest);
    const currentHash = sha256(original);
    const runtimeMatches =
      existing.nodeExecutablePath === nodeExecutablePath &&
      existing.runtimeExecutablePath === runtimeTarget &&
      existing.runtimeExecutableSha256 === sourceRuntimeHash;
    if (
      existing.configPath !== path ||
      currentHash !== existing.configAfterSha256 ||
      rendered.text !== originalText
    ) {
      throw new Error(
        "an install manifest already exists but the managed config changed; run doctor before reinstalling",
      );
    }
    const hostMatches =
      !existing.ccBinarySha256 || hostBefore.sha256 === existing.ccBinarySha256;
    let installedRuntimeMatches = false;
    try {
      installedRuntimeMatches =
        (await sha256File(existing.runtimeExecutablePath)) ===
        existing.runtimeExecutableSha256;
    } catch {
      installedRuntimeMatches = false;
    }
    const changed = !runtimeMatches || !installedRuntimeMatches;
    if (!options.dryRun && changed) {
      if (!runtimeMatches) {
        throw new Error(
          "the installed proxy belongs to another package version; uninstall before upgrading",
        );
      }
      await installRuntime(runtimeSource, runtimeTarget);
    }
    return {
      changed,
      dryRun: Boolean(options.dryRun),
      configPath: path,
      projects: existing.projects,
      agents: ["codex"],
      nodeExecutablePath,
      runtimeExecutablePath: runtimeTarget,
      hostBinary: { ...hostBefore, unchanged: hostMatches },
      backupPath: existing.backupPath,
    };
  }

  if (await legacyCheck(env)) {
    throw new Error(
      "legacy Codex MCP registration feishu_plus is still present; uninstall v0.1.2 before installing the automatic proxy runtime",
    );
  }

  if (options.dryRun) {
    return {
      changed: rendered.text !== originalText,
      dryRun: true,
      configPath: path,
      projects: rendered.projects,
      agents: ["codex"],
      nodeExecutablePath,
      runtimeExecutablePath: runtimeTarget,
      hostBinary: { ...hostBefore, unchanged: true },
    };
  }

  const directory = pluginDataDir(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const backupPath = join(directory, `${basename(path)}.${timestamp()}.bak`);
  await writeFile(backupPath, original, { mode: 0o600, flag: "wx" });
  const originalMode = (await stat(path)).mode & 0o777;

  try {
    const installedRuntimeHash = await installRuntime(runtimeSource, runtimeTarget);
    if (installedRuntimeHash !== sourceRuntimeHash) {
      throw new Error("installed proxy runtime failed its integrity check");
    }
    await atomicWrite(path, rendered.text, originalMode);

    const hostAfter = await discoverHostBinary(env);
    if (
      !hostAfter ||
      hostAfter.path !== hostBefore.path ||
      hostAfter.sha256 !== hostBefore.sha256
    ) {
      throw new Error("official CC Connect binary changed during installation");
    }

    const manifest: InstallManifest = {
      version: 2,
      packageVersion: PACKAGE_VERSION,
      installedAt: new Date().toISOString(),
      configPath: path,
      backupPath,
      configBeforeSha256: sha256(original),
      configAfterSha256: sha256(rendered.text),
      ccBinaryPath: hostBefore.path,
      ccBinarySha256: hostBefore.sha256,
      nodeExecutablePath,
      runtimeExecutablePath: runtimeTarget,
      runtimeExecutableSha256: installedRuntimeHash,
      projects: rendered.projects,
    };
    await atomicWrite(manifestPath(env), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);

    return {
      changed: rendered.text !== originalText,
      dryRun: false,
      configPath: path,
      projects: rendered.projects,
      agents: ["codex"],
      nodeExecutablePath,
      runtimeExecutablePath: runtimeTarget,
      hostBinary: { ...hostAfter, unchanged: true },
      backupPath,
    };
  } catch (error) {
    await atomicWrite(path, original, originalMode).catch(() => undefined);
    await rm(dirname(runtimeTarget), { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

export interface UninstallOptions {
  env?: NodeJS.ProcessEnv;
}

export interface UninstallResult {
  manifest: InstallManifest;
  warnings: string[];
}

export async function uninstall(
  options: UninstallOptions = {},
): Promise<UninstallResult> {
  const env = options.env ?? process.env;
  const unknownManifest = await readUnknownManifest(env);
  if (!unknownManifest) throw new Error("Feishu Plus is not installed");
  const manifest = requireCurrentManifest(unknownManifest);

  const current = await readFile(manifest.configPath);
  if (sha256(current) !== manifest.configAfterSha256) {
    throw new Error(
      "CC Connect config changed after installation; refusing to overwrite user changes",
    );
  }
  const backup = await readFile(manifest.backupPath);
  if (sha256(backup) !== manifest.configBeforeSha256) {
    throw new Error("the installation backup failed its integrity check");
  }
  const mode = (await stat(manifest.configPath)).mode & 0o777;
  await atomicWrite(manifest.configPath, backup, mode);

  const warnings: string[] = [];
  try {
    await rm(dirname(manifest.runtimeExecutablePath), {
      recursive: true,
      force: true,
    });
  } catch {
    warnings.push("proxy runtime cleanup failed; remove the recorded runtime directory manually");
  }
  const historyPath = join(
    pluginDataDir(env),
    `install-manifest.uninstalled-${timestamp()}.json`,
  );
  await atomicWrite(
    historyPath,
    `${JSON.stringify(
      { ...manifest, uninstalledAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
    0o600,
  );
  await rm(manifestPath(env));
  return { manifest, warnings };
}

export async function verifyHostAgainstManifest(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ current?: string; installed?: string; unchanged?: boolean }> {
  const unknownManifest = await readUnknownManifest(env);
  const manifest = unknownManifest?.version === 2
    ? (unknownManifest as InstallManifest)
    : undefined;
  const host = await discoverHostBinary(env);
  if (!host) return {};
  return {
    current: await sha256File(host.path),
    ...(manifest?.ccBinarySha256 ? { installed: manifest.ccBinarySha256 } : {}),
    ...(manifest?.ccBinarySha256
      ? { unchanged: host.sha256 === manifest.ccBinarySha256 }
      : {}),
  };
}
