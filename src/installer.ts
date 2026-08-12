import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import {
  codexMcpContextEnvIsConfigured,
  configureCodexMcpContextEnv,
} from "./codex-mcp.js";
import { renderConfigForInstall } from "./config.js";
import {
  discoverHostBinary,
  sha256File,
  versionAtLeast,
} from "./host-integrity.js";
import { configPath as defaultConfigPath, manifestPath, pluginDataDir } from "./paths.js";
import { runCommand, type CommandRunner } from "./process.js";
import type { AgentType, InstallManifest } from "./types.js";
import {
  MCP_NAME,
  MINIMUM_CC_CONNECT_VERSION,
  PACKAGE_VERSION,
  RUNTIME_PACKAGE_SPEC,
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

function runtimePackageSpec(packageVersion: string): string {
  return `github:timmyagentic/cc-connect-feishu-plus#v${packageVersion}`;
}

function registrationArgs(
  agentType: AgentType,
  configPath: string,
  packageSpec = RUNTIME_PACKAGE_SPEC,
): string[] {
  const runtime = [
    "npm",
    "exec",
    "--yes",
    `--package=${packageSpec}`,
    "--",
    "cc-connect-feishu-plus",
    "mcp",
  ];
  return agentType === "codex"
    ? ["mcp", "add", MCP_NAME, "--env", `CC_CONFIG_PATH=${configPath}`, "--", ...runtime]
    : [
        "mcp",
        "add",
        "--scope",
        "user",
        MCP_NAME,
        "-e",
        `CC_CONFIG_PATH=${configPath}`,
        "--",
        ...runtime,
      ];
}

function removalArgs(agentType: AgentType): string[] {
  return agentType === "codex"
    ? ["mcp", "remove", MCP_NAME]
    : ["mcp", "remove", "--scope", "user", MCP_NAME];
}

function agentCommand(agentType: AgentType): string {
  return agentType === "codex" ? "codex" : "claude";
}

export interface InstallOptions {
  configPath?: string;
  projectNames?: string[];
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  commandRunner?: CommandRunner;
  configureCodexContextEnv?: typeof configureCodexMcpContextEnv;
  codexContextEnvIsConfigured?: typeof codexMcpContextEnvIsConfigured;
}

export interface InstallResult {
  changed: boolean;
  dryRun: boolean;
  configPath: string;
  projects: Array<{ name: string; agentType: AgentType }>;
  agents: AgentType[];
  hostBinary?: { path: string; sha256: string; unchanged: boolean };
  backupPath?: string;
}

async function readManifest(env: NodeJS.ProcessEnv): Promise<InstallManifest | undefined> {
  try {
    return JSON.parse(await readFile(manifestPath(env), "utf8")) as InstallManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureMcpNameFree(
  agentType: AgentType,
  runner: CommandRunner,
): Promise<void> {
  const result = await runner(agentCommand(agentType), ["mcp", "get", MCP_NAME]);
  if (result.code === 0) {
    throw new Error(
      `${MCP_NAME} is already registered in ${agentType}; refusing to overwrite it`,
    );
  }
}

export async function install(options: InstallOptions = {}): Promise<InstallResult> {
  const env = options.env ?? process.env;
  const path = options.configPath ?? defaultConfigPath(env);
  const runner = options.commandRunner ?? runCommand;
  const configureCodexContextEnv =
    options.configureCodexContextEnv ?? configureCodexMcpContextEnv;
  const contextEnvIsConfigured =
    options.codexContextEnvIsConfigured ?? codexMcpContextEnvIsConfigured;
  const original = await readFile(path);
  const originalText = original.toString("utf8");
  const rendered = renderConfigForInstall(
    originalText,
    { ...(options.projectNames ? { projectNames: options.projectNames } : {}) },
    env,
  );
  const agents = [...new Set(rendered.projects.map((project) => project.agentType))];
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
  const existing = await readManifest(env);

  if (existing) {
    const currentHash = sha256(original);
    if (
      existing.configPath !== path ||
      currentHash !== existing.configAfterSha256 ||
      rendered.text !== originalText
    ) {
      throw new Error(
        "an install manifest already exists but the managed config changed; run doctor before reinstalling",
      );
    }

    const registeredAgents = existing.mcpRegistrations.map(
      (registration) => registration.agentType,
    );
    const needsContextRepair =
      registeredAgents.includes("codex") && !(await contextEnvIsConfigured(env));
    const needsRuntimeUpgrade = existing.packageVersion !== PACKAGE_VERSION;
    if (options.dryRun) {
      return {
        changed: needsContextRepair || needsRuntimeUpgrade,
        dryRun: true,
        configPath: path,
        projects: existing.projects,
        agents: registeredAgents,
        ...(hostBefore
          ? { hostBinary: { ...hostBefore, unchanged: hostBefore.sha256 === existing.ccBinarySha256 } }
          : {}),
        backupPath: existing.backupPath,
      };
    }

    if (needsRuntimeUpgrade) {
      const previousSpec = runtimePackageSpec(existing.packageVersion);
      const touched: AgentType[] = [];
      try {
        for (const registration of existing.mcpRegistrations) {
          const agent = registration.agentType;
          const removed = await runner(agentCommand(agent), removalArgs(agent));
          if (removed.code !== 0) {
            throw new Error(`failed to remove the previous ${MCP_NAME} ${agent} registration`);
          }
          touched.push(agent);
          const added = await runner(
            agentCommand(agent),
            registrationArgs(agent, path),
          );
          if (added.code !== 0) {
            throw new Error(`failed to upgrade ${MCP_NAME} in ${agent}`);
          }
          if (agent === "codex") await configureCodexContextEnv(env);
        }
        const hostAfterRegistration = await discoverHostBinary(env);
        if (
          !hostAfterRegistration ||
          hostAfterRegistration.path !== hostBefore.path ||
          hostAfterRegistration.sha256 !== hostBefore.sha256
        ) {
          throw new Error("official CC Connect binary changed during installation upgrade");
        }
        await atomicWrite(
          manifestPath(env),
          `${JSON.stringify(
            {
              ...existing,
              packageVersion: PACKAGE_VERSION,
              updatedAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
          0o600,
        );
      } catch (error) {
        for (const agent of touched.reverse()) {
          await runner(agentCommand(agent), removalArgs(agent)).catch(() => undefined);
          await runner(
            agentCommand(agent),
            registrationArgs(agent, path, previousSpec),
          ).catch(() => undefined);
          if (agent === "codex") {
            await configureCodexContextEnv(env).catch(() => undefined);
          }
        }
        throw error;
      }
    } else if (needsContextRepair) {
      await configureCodexContextEnv(env);
    }

    const hostAfter = await discoverHostBinary(env);
    return {
      changed: needsContextRepair || needsRuntimeUpgrade,
      dryRun: false,
      configPath: path,
      projects: existing.projects,
      agents: registeredAgents,
      ...(hostAfter
        ? {
            hostBinary: {
              ...hostAfter,
              unchanged:
                !existing.ccBinarySha256 ||
                hostAfter.sha256 === existing.ccBinarySha256,
            },
          }
        : {}),
      backupPath: existing.backupPath,
    };
  }

  if (options.dryRun) {
    return {
      changed: rendered.text !== originalText,
      dryRun: true,
      configPath: path,
      projects: rendered.projects,
      agents,
      ...(hostBefore ? { hostBinary: { ...hostBefore, unchanged: true } } : {}),
    };
  }

  for (const agent of agents) await ensureMcpNameFree(agent, runner);

  const directory = pluginDataDir(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const backupPath = join(directory, `${basename(path)}.${timestamp()}.bak`);
  await writeFile(backupPath, original, { mode: 0o600, flag: "wx" });
  const originalMode = (await stat(path)).mode & 0o777;
  const registered: AgentType[] = [];

  try {
    for (const agent of agents) {
      const result = await runner(agentCommand(agent), registrationArgs(agent, path));
      if (result.code !== 0) {
        throw new Error(`failed to register ${MCP_NAME} in ${agent}`);
      }
      registered.push(agent);
      if (agent === "codex") await configureCodexContextEnv(env);
    }

    await atomicWrite(path, rendered.text, originalMode);
    const hostAfter = await discoverHostBinary(env);
    if (
      hostBefore &&
      (!hostAfter || hostAfter.path !== hostBefore.path || hostAfter.sha256 !== hostBefore.sha256)
    ) {
      throw new Error("official CC Connect binary changed during installation");
    }

    const manifest: InstallManifest = {
      version: 1,
      packageVersion: PACKAGE_VERSION,
      installedAt: new Date().toISOString(),
      configPath: path,
      backupPath,
      configBeforeSha256: sha256(original),
      configAfterSha256: sha256(rendered.text),
      ...(hostBefore
        ? { ccBinaryPath: hostBefore.path, ccBinarySha256: hostBefore.sha256 }
        : {}),
      projects: rendered.projects,
      mcpRegistrations: registered.map((agentType) => ({
        agentType,
        name: MCP_NAME,
      })),
    };
    await atomicWrite(manifestPath(env), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);

    return {
      changed: rendered.text !== originalText,
      dryRun: false,
      configPath: path,
      projects: rendered.projects,
      agents,
      ...(hostAfter ? { hostBinary: { ...hostAfter, unchanged: true } } : {}),
      backupPath,
    };
  } catch (error) {
    await atomicWrite(path, original, originalMode).catch(() => undefined);
    for (const agent of registered.reverse()) {
      await runner(agentCommand(agent), removalArgs(agent)).catch(() => undefined);
    }
    throw error;
  }
}

export interface UninstallOptions {
  env?: NodeJS.ProcessEnv;
  commandRunner?: CommandRunner;
}

export interface UninstallResult {
  manifest: InstallManifest;
  warnings: string[];
}

export async function uninstall(options: UninstallOptions = {}): Promise<UninstallResult> {
  const env = options.env ?? process.env;
  const runner = options.commandRunner ?? runCommand;
  const manifest = await readManifest(env);
  if (!manifest) throw new Error("Feishu Plus is not installed");

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
  for (const registration of manifest.mcpRegistrations) {
    const result = await runner(
      agentCommand(registration.agentType),
      removalArgs(registration.agentType),
    );
    if (result.code !== 0) {
      warnings.push(`${registration.agentType} MCP removal failed; remove ${MCP_NAME} manually`);
    }
  }
  const historyPath = join(
    pluginDataDir(env),
    `install-manifest.uninstalled-${timestamp()}.json`,
  );
  await atomicWrite(
    historyPath,
    `${JSON.stringify({ ...manifest, uninstalledAt: new Date().toISOString() }, null, 2)}\n`,
    0o600,
  );
  await rename(manifestPath(env), `${historyPath}.installed-record`);
  return { manifest, warnings };
}

export async function verifyHostAgainstManifest(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ current?: string; installed?: string; unchanged?: boolean }> {
  const manifest = await readManifest(env);
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
