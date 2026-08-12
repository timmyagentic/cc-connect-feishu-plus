import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { codexMcpContextEnvIsConfigured } from "./codex-mcp.js";
import { parseConfig } from "./config.js";
import { discoverHostBinary, versionAtLeast } from "./host-integrity.js";
import { configPath as defaultConfigPath, manifestPath, socketPath } from "./paths.js";
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
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function maybeManifest(env: NodeJS.ProcessEnv): Promise<InstallManifest | undefined> {
  try {
    return JSON.parse(await readFile(manifestPath(env), "utf8")) as InstallManifest;
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
  try {
    configBytes = await readFile(path);
    const parsed = parseConfig(configBytes.toString("utf8"), env);
    checks.push({
      name: "cc-config",
      ok: parsed.projects.length > 0,
      detail: `${parsed.projects.length} compatible Feishu project(s)`,
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
      detail: info.isSocket() ? "native local API socket is available" : "path is not a socket",
    });
  } catch {
    checks.push({ name: "cc-socket", ok: false, detail: "native local API socket is unavailable" });
  }

  const manifest = await maybeManifest(env);
  checks.push({
    name: "install-manifest",
    ok: Boolean(manifest),
    detail: manifest ? `installed plugin ${manifest.packageVersion}` : "not installed (dry-run is still available)",
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

  if (manifest?.projects.some((project) => project.agentType === "codex")) {
    const configured = await codexMcpContextEnvIsConfigured(env);
    checks.push({
      name: "codex-mcp-context-env",
      ok: configured,
      detail: configured
        ? "CC_PROJECT and CC_SESSION_KEY are forwarded to the Codex MCP process"
        : "Codex MCP env_vars must include CC_PROJECT and CC_SESSION_KEY",
    });
  }

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
    detail: "plugin contains no event WebSocket client and reuses CC Connect native inbound routing",
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
    },
  };
}
