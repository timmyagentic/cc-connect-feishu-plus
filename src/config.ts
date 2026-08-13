import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { configPath as defaultConfigPath } from "./paths.js";
import { PACKAGE_VERSION } from "./version.js";
import type {
  AgentType,
  FeishuPlatformConfig,
  InstalledProject,
  ProjectRuntimeConfig,
} from "./types.js";

const LEGACY_PROMPT_BEGIN = "<cc-connect-feishu-plus version=\"1\">";
const LEGACY_PROMPT_END = "</cc-connect-feishu-plus>";
const REAL_COMMAND_FLAG = "--ccfp-real-command=";
const CONFIG_PATH_FLAG = "--ccfp-config=";

interface RawPlatform {
  type?: unknown;
  options?: unknown;
}

interface RawAgent {
  type?: unknown;
  options?: unknown;
}

interface RawProject {
  name?: unknown;
  agent?: RawAgent;
  platforms?: RawPlatform[];
  references?: unknown;
}

interface RawConfig {
  projects?: RawProject[];
}

export interface ParsedConfig {
  raw: RawConfig;
  projects: ProjectRuntimeConfig[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveEnvironmentValue(
  value: unknown,
  label: string,
  env: NodeJS.ProcessEnv,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is missing`);
  }

  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === "") {
      throw new Error(`${label} references an unset environment variable`);
    }
    return resolved;
  });
}

function platformBaseUrl(
  type: "feishu" | "lark",
  options: Record<string, unknown>,
): string {
  const custom = options.domain;
  if (typeof custom === "string" && custom.trim() !== "") {
    new URL(custom.trim());
    return custom.trim().replace(/\/$/, "");
  }
  return type === "lark"
    ? "https://open.larksuite.com"
    : "https://open.feishu.cn";
}

function parseFeishuPlatform(
  projectName: string,
  platforms: RawPlatform[],
  env: NodeJS.ProcessEnv,
): FeishuPlatformConfig | undefined {
  const matches = platforms.filter(
    (platform) => platform.type === "feishu" || platform.type === "lark",
  );
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    throw new Error(`project ${projectName} has multiple Feishu/Lark platforms`);
  }

  const platform = matches[0];
  if (!platform || (platform.type !== "feishu" && platform.type !== "lark")) {
    return undefined;
  }
  const options = record(platform.options);
  return {
    type: platform.type,
    appId: resolveEnvironmentValue(options.app_id, `${projectName} app_id`, env),
    appSecret: resolveEnvironmentValue(
      options.app_secret,
      `${projectName} app_secret`,
      env,
    ),
    baseUrl: platformBaseUrl(platform.type, options),
    replyToTrigger: options.reply_to_trigger !== false,
  };
}

function stringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function configuredAgentCommand(
  agentType: AgentType,
  options: Record<string, unknown>,
): string {
  return (
    stringOption(options, "cmd") ??
    stringOption(options, "cli_path") ??
    stringOption(options, "command") ??
    (agentType === "codex" ? "codex" : "claude")
  );
}

function configuredBackend(options: Record<string, unknown>): string {
  return stringOption(options, "backend")?.toLowerCase() ?? "exec";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function referenceConfig(value: unknown): ProjectRuntimeConfig["references"] {
  const raw = record(value);
  const normalizeAgents = stringList(raw.normalize_agents);
  const renderPlatforms = stringList(raw.render_platforms);
  if (normalizeAgents.length === 0 || renderPlatforms.length === 0) return undefined;
  return {
    normalizeAgents,
    renderPlatforms,
    displayPath: stringOption(raw, "display_path") ?? "dirname_basename",
    markerStyle: stringOption(raw, "marker_style") ?? "emoji",
    enclosureStyle: stringOption(raw, "enclosure_style") ?? "code",
  };
}

export function parseConfig(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): ParsedConfig {
  const raw = parse(text) as RawConfig;
  const projects: ProjectRuntimeConfig[] = [];

  for (const project of raw.projects ?? []) {
    if (typeof project.name !== "string" || project.name.trim() === "") continue;
    const agentType = project.agent?.type;
    if (agentType !== "codex" && agentType !== "claudecode") continue;
    const feishu = parseFeishuPlatform(project.name, project.platforms ?? [], env);
    if (!feishu) continue;
    const options = record(project.agent?.options);
    const workDir = stringOption(options, "work_dir");
    const references = referenceConfig(project.references);
    projects.push({
      name: project.name,
      agentType: agentType as AgentType,
      agentCommand: configuredAgentCommand(agentType as AgentType, options),
      backend: configuredBackend(options),
      ...(workDir ? { workDir } : {}),
      ...(typeof options.append_system_prompt === "string"
        ? { appendSystemPrompt: options.append_system_prompt }
        : {}),
      ...(references ? { references } : {}),
      feishu,
    });
  }

  return { raw, projects };
}

export async function loadConfig(
  path = defaultConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ParsedConfig> {
  return parseConfig(await readFile(path, "utf8"), env);
}

export async function loadProjectConfig(
  projectName: string,
  path = defaultConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectRuntimeConfig> {
  const parsed = await loadConfig(path, env);
  const project = parsed.projects.find((item) => item.name === projectName);
  if (!project) {
    throw new Error(`Feishu project ${projectName} was not found in CC Connect config`);
  }
  return project;
}

export function stripLegacySystemPrompt(existing: string | undefined): string {
  return (existing ?? "")
    .replace(
      new RegExp(`${LEGACY_PROMPT_BEGIN}[\\s\\S]*?${LEGACY_PROMPT_END}`, "g"),
      "",
    )
    .trim();
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function findTable(
  lines: string[],
  header: string,
): { start: number; end: number } | undefined {
  const exact = `[${header}]`;
  const start = lines.findIndex((line) => line.trim() === exact);
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function setTableKeys(
  lines: string[],
  header: string,
  values: Record<string, string>,
  insertAt: number,
): void {
  let table = findTable(lines, header);
  if (!table) {
    const prefix = insertAt > 0 && lines[insertAt - 1]?.trim() !== "" ? [""] : [];
    lines.splice(
      insertAt,
      0,
      ...prefix,
      `[${header}]`,
      ...Object.entries(values).map(([key, value]) => `${key} = ${value}`),
      "",
    );
    return;
  }

  for (const [key, value] of Object.entries(values)) {
    const keyPattern = new RegExp(`^\\s*${key}\\s*=`);
    const existing = lines.findIndex(
      (line, index) => index > table!.start && index < table!.end && keyPattern.test(line),
    );
    if (existing >= 0) {
      const indent = lines[existing]?.match(/^\s*/)?.[0] ?? "";
      lines[existing] = `${indent}${key} = ${value}`;
    } else {
      lines.splice(table.end, 0, `${key} = ${value}`);
      table = { ...table, end: table.end + 1 };
    }
  }
}

function projectSpans(lines: string[]): Array<{ start: number; end: number }> {
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === "[[projects]]") starts.push(index);
  });
  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? lines.length,
  }));
}

function projectNameFromBlock(block: string[]): string | undefined {
  const nameLine = block.find((line) => /^\s*name\s*=/.test(line));
  if (!nameLine) return undefined;
  return nameLine.match(/^\s*name\s*=\s*(["'])(.*?)\1/)?.[2];
}

function insertAfterTable(lines: string[], header: string, fallback: number): number {
  return findTable(lines, header)?.end ?? fallback;
}

function commandParts(command: string): string[] {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("Codex agent command is empty");
  return parts;
}

function encodeToken(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeToken<T>(value: string): T | undefined {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

export function decodeOriginalCommand(proxyCommand: string): string | undefined {
  const flag = commandParts(proxyCommand).find((part) => part.startsWith(REAL_COMMAND_FLAG));
  if (!flag) return undefined;
  const parts = decodeToken<unknown>(flag.slice(REAL_COMMAND_FLAG.length));
  if (!Array.isArray(parts) || !parts.every((part) => typeof part === "string")) {
    return undefined;
  }
  return parts.join(" ");
}

export function buildProxyAgentCommand(
  nodeExecutablePath: string,
  runtimeExecutablePath: string,
  originalCommand: string,
  configPath: string,
): string {
  if (/\s/.test(nodeExecutablePath) || /\s/.test(runtimeExecutablePath)) {
    throw new Error(
      "Node or plugin runtime path contains whitespace and cannot be used by CC Connect",
    );
  }
  return [
    nodeExecutablePath,
    runtimeExecutablePath,
    `${REAL_COMMAND_FLAG}${encodeToken(commandParts(originalCommand))}`,
    `${CONFIG_PATH_FLAG}${encodeToken(configPath)}`,
  ].join(" ");
}

export interface RenderInstallOptions {
  nodeExecutablePath: string;
  runtimeExecutablePath: string;
  configPath: string;
  projectNames?: string[];
}

export interface RenderInstallResult {
  text: string;
  projects: InstalledProject[];
}

export function renderConfigForInstall(
  text: string,
  options: RenderInstallOptions,
  env: NodeJS.ProcessEnv = process.env,
): RenderInstallResult {
  const parsed = parseConfig(text, env);
  const requested = options.projectNames
    ? new Set(options.projectNames)
    : undefined;
  const selected = requested
    ? parsed.projects.filter((project) => requested.has(project.name))
    : parsed.projects.filter(
        (project) => project.agentType === "codex" && project.backend === "exec",
      );
  if (selected.length === 0) {
    throw new Error("no compatible Codex Feishu projects were selected");
  }
  if (requested) {
    for (const name of requested) {
      if (!selected.some((project) => project.name === name)) {
        throw new Error(`project ${name} is not a Codex/Feishu project`);
      }
    }
  }
  for (const project of selected) {
    if (project.agentType !== "codex") {
      throw new Error(
        `project ${project.name} uses ${project.agentType}; v${PACKAGE_VERSION} supports Codex exec only`,
      );
    }
    if (project.backend !== "exec") {
      throw new Error(
        `project ${project.name} uses the ${project.backend} backend; v${PACKAGE_VERSION} supports Codex exec only`,
      );
    }
  }

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = text.endsWith("\n");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (hadFinalNewline) lines.pop();

  const installedProjects: InstalledProject[] = [];
  const byName = new Map(selected.map((project) => [project.name, project]));
  for (const span of [...projectSpans(lines)].reverse()) {
    const block = lines.slice(span.start, span.end);
    const name = projectNameFromBlock(block);
    if (!name) continue;
    const project = byName.get(name);
    if (!project || project.agentType !== "codex") continue;

    const originalAgentCommand =
      decodeOriginalCommand(project.agentCommand) ?? project.agentCommand;
    const proxyAgentCommand = buildProxyAgentCommand(
      options.nodeExecutablePath,
      options.runtimeExecutablePath,
      originalAgentCommand,
      options.configPath,
    );
    const agentValues: Record<string, string> = {
      cmd: tomlString(proxyAgentCommand),
    };
    const strippedPrompt = stripLegacySystemPrompt(project.appendSystemPrompt);
    if (project.appendSystemPrompt !== undefined && strippedPrompt !== project.appendSystemPrompt) {
      agentValues.append_system_prompt = tomlString(strippedPrompt);
    }

    const agentInsert = insertAfterTable(block, "projects.agent", 1);
    setTableKeys(block, "projects.agent.options", agentValues, agentInsert);
    const displayInsert = insertAfterTable(block, "projects.agent.options", block.length);
    setTableKeys(
      block,
      "projects.display",
      {
        thinking_messages: "false",
        tool_messages: "false",
        show_context_indicator: "false",
        reply_footer: "false",
      },
      displayInsert,
    );
    lines.splice(span.start, span.end - span.start, ...block);
    installedProjects.push({
      name: project.name,
      agentType: "codex",
      originalAgentCommand,
      proxyAgentCommand,
    });
  }

  installedProjects.reverse();
  return {
    text: `${lines.join(newline)}${hadFinalNewline ? newline : ""}`,
    projects: installedProjects,
  };
}
