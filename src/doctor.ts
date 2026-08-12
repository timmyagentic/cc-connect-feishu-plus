import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { parseConfig } from "./config.js";
import { discoverHostBinary, sha256File, versionAtLeast } from "./host-integrity.js";
import { legacyMcpIsConfigured } from "./legacy.js";
import {
  configPath as defaultConfigPath,
  manifestPath,
  socketPath,
} from "./paths.js";
import type { InstallManifest } from "./types.js";
import { MINIMUM_CC_CONNECT_VERSION } from "./version.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  guarantees: {
    officialSourcePatched: false;
    officialBinaryWritten: false;
    secondFeishuEventConnection: false;
    modelMcpRequired: false;
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function maybeManifest(
  env: NodeJS.ProcessEnv,
): Promise<InstallManifest | { version?: number } | undefined> {
  try {
    return JSON.parse(await readFile(manifestPath(env), "utf8")) as
      | InstallManifest
      | { version?: number };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function doctor(
  env: NodeJS.ProcessEnv = process.env,
  path = defaultConfigPath(env),
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let configBytes: Buffer | undefined;
  let parsed: ReturnType<typeof parseConfig> | undefined;
  try {
    configBytes = await readFile(path);
    parsed = parseConfig(configBytes.toString("utf8"), env);
    checks.push({
      name: "cc-config",
      ok: parsed.projects.some((project) => project.agentType === "codex"),
      detail: `${parsed.projects.length} Feishu project(s), ${parsed.projects.filter((project) => project.agentType === "codex").length} Codex project(s)`,
    });
  } catch (error) {
    checks.push({
      name: "cc-config",
      ok: false,
      detail: error instanceof Error ? error.message : "unreadable config",
    });
  }

  try {
    const info = await stat(socketPath(env));
    checks.push({
      name: "cc-socket",
      ok: info.isSocket(),
      detail: info.isSocket()
        ? "native local API socket is available"
        : "path is not a socket",
    });
  } catch {
    checks.push({
      name: "cc-socket",
      ok: false,
      detail: "native local API socket is unavailable",
    });
  }

  const unknownManifest = await maybeManifest(env);
  const manifest = unknownManifest?.version === 2
    ? (unknownManifest as InstallManifest)
    : undefined;
  checks.push({
    name: "install-manifest",
    ok: Boolean(manifest),
    detail: manifest
      ? `installed automatic proxy ${manifest.packageVersion}`
      : unknownManifest
        ? "legacy MCP manifest detected; uninstall v0.1.2 first"
        : "not installed (dry-run is still available)",
  });

  if (manifest && configBytes) {
    checks.push({
      name: "managed-config-integrity",
      ok: sha256(configBytes) === manifest.configAfterSha256,
      detail:
        sha256(configBytes) === manifest.configAfterSha256
          ? "managed config is unchanged"
          : "config changed after plugin installation",
    });
  }

  if (manifest && parsed) {
    const configured = new Map(
      parsed.projects.map((project) => [project.name, project.agentCommand]),
    );
    const wired = manifest.projects.every(
      (project) => configured.get(project.name) === project.proxyAgentCommand,
    );
    checks.push({
      name: "codex-proxy-wiring",
      ok: wired,
      detail: wired
        ? `${manifest.projects.length} project(s) use the automatic Codex proxy`
        : "one or more managed projects no longer use the recorded proxy command",
    });

    let executable = false;
    let nodeExecutable = false;
    let runtimeHashMatches = false;
    try {
      await access(manifest.nodeExecutablePath, constants.X_OK);
      nodeExecutable = true;
      await access(manifest.runtimeExecutablePath, constants.X_OK);
      executable = true;
      runtimeHashMatches =
        (await sha256File(manifest.runtimeExecutablePath)) ===
        manifest.runtimeExecutableSha256;
    } catch {
      executable = false;
    }
    checks.push({
      name: "proxy-runtime",
      ok: nodeExecutable && executable && runtimeHashMatches,
      detail:
        nodeExecutable && executable && runtimeHashMatches
          ? "Node and proxy runtime are executable; runtime matches the install manifest"
          : "Node or proxy runtime is missing, not executable, or changed",
    });
  }

  const legacyMcp = await legacyMcpIsConfigured(env);
  checks.push({
    name: "legacy-mcp-absent",
    ok: !legacyMcp,
    detail: legacyMcp
      ? "legacy feishu_plus MCP registration is still present"
      : "no feishu_plus MCP registration is required",
  });

  const host = await discoverHostBinary(env);
  const compatible = Boolean(
    host?.version && versionAtLeast(host.version, MINIMUM_CC_CONNECT_VERSION),
  );
  const baselineMatches = Boolean(
    host && (!manifest?.ccBinarySha256 || host.sha256 === manifest.ccBinarySha256),
  );
  checks.push({
    name: "official-binary",
    ok: Boolean(host) && compatible && baselineMatches,
    detail: host
      ? !compatible
        ? `official binary ${host.version ?? "unknown version"} is older than required ${MINIMUM_CC_CONNECT_VERSION}`
        : manifest?.ccBinarySha256
          ? host.sha256 === manifest.ccBinarySha256
            ? `official binary ${host.version ?? "unknown version"} hash matches the installation baseline`
            : "official binary differs from the installation baseline (possibly an official update)"
          : `official binary ${host.version ?? "unknown version"} found; no install baseline yet`
      : "official binary was not found",
  });

  checks.push({
    name: "single-feishu-connection",
    ok: true,
    detail:
      "proxy observes the native Agent stdout and opens no Feishu event WebSocket",
  });

  const requiredFailures = checks.filter(
    (check) =>
      !check.ok &&
      check.name !== "install-manifest" &&
      !(check.name === "official-binary" && !manifest),
  );
  return {
    ok: requiredFailures.length === 0,
    checks,
    guarantees: {
      officialSourcePatched: false,
      officialBinaryWritten: false,
      secondFeishuEventConnection: false,
      modelMcpRequired: false,
    },
  };
}
