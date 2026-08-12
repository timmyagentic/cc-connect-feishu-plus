import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { configPath as defaultConfigPath } from "./paths.js";
import type {
  AgentType,
  FeishuPlatformConfig,
  ProjectRuntimeConfig,
} from "./types.js";

const PROMPT_BEGIN = "<cc-connect-feishu-plus version=\"1\">";
const PROMPT_END = "</cc-connect-feishu-plus>";

export const FEISHU_PLUS_SYSTEM_PROMPT = `${PROMPT_BEGIN}
For every CC Connect turn, call mcp__feishu_plus__turn_begin before producing text or calling any other tool. If it reports active=true, keep private reasoning, shell commands, and raw tool details out of chat. You may report only a safe phase through mcp__feishu_plus__turn_activity. Once user-facing answer prose is ready, append it in coherent final-quality chunks through mcp__feishu_plus__turn_write whenever that helps a long answer appear progressively; never send thoughts, plans, commands, or provisional claims through turn_write. Before ending the turn, call mcp__feishu_plus__turn_complete with the complete user-facing Markdown answer, or mcp__feishu_plus__turn_fail if no useful answer can be produced. After either finalization tool succeeds, your entire assistant response must be exactly NO_REPLY. If turn_begin reports active=false or the tool is unavailable, answer normally through CC Connect.
${PROMPT_END}`;

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
}

interface RawConfig {
  projects?: RawProject[];
  stream_preview?: { disabled_platforms?: unknown };
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

function platformBaseUrl(type: "feishu" | "lark", options: Record<string, unknown>): string {
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
    projects.push({
      name: project.name,
      agentType: agentType as AgentType,
      ...(typeof options.append_system_prompt === "string"
        ? { appendSystemPrompt: options.append_system_prompt }
        : {}),
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

export function mergeSystemPrompt(existing: string | undefined): string {
  const withoutPlugin = (existing ?? "")
    .replace(new RegExp(`${PROMPT_BEGIN}[\\s\\S]*?${PROMPT_END}`, "g"), "")
    .trim();
  return withoutPlugin
    ? `${withoutPlugin}\n\n${FEISHU_PLUS_SYSTEM_PROMPT}`
    : FEISHU_PLUS_SYSTEM_PROMPT;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function findTable(lines: string[], header: string): { start: number; end: number } | undefined {
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
    lines.splice(insertAt, 0, ...prefix, `[${header}]`, ...Object.entries(values).map(
      ([key, value]) => `${key} = ${value}`,
    ), "");
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
  const match = nameLine.match(/^\s*name\s*=\s*(["'])(.*?)\1/);
  return match?.[2];
}

function insertAfterTable(lines: string[], header: string, fallback: number): number {
  return findTable(lines, header)?.end ?? fallback;
}

export interface RenderInstallOptions {
  projectNames?: string[];
}

export interface RenderInstallResult {
  text: string;
  projects: Array<{ name: string; agentType: AgentType }>;
}

export function renderConfigForInstall(
  text: string,
  options: RenderInstallOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): RenderInstallResult {
  const parsed = parseConfig(text, env);
  const requested = new Set(options.projectNames ?? parsed.projects.map((project) => project.name));
  const selected = parsed.projects.filter((project) => requested.has(project.name));
  if (selected.length === 0) {
    throw new Error("no compatible Codex/Claude Feishu projects were selected");
  }
  for (const name of requested) {
    if (!selected.some((project) => project.name === name)) {
      throw new Error(`project ${name} is not a compatible Codex/Claude Feishu project`);
    }
  }

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = text.endsWith("\n");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (hadFinalNewline) lines.pop();

  const byName = new Map(selected.map((project) => [project.name, project]));
  const spans = projectSpans(lines);
  for (const span of [...spans].reverse()) {
    const block = lines.slice(span.start, span.end);
    const name = projectNameFromBlock(block);
    if (!name) continue;
    const project = byName.get(name);
    if (!project) continue;

    const agentInsert = insertAfterTable(block, "projects.agent", 1);
    setTableKeys(
      block,
      "projects.agent.options",
      { append_system_prompt: tomlString(mergeSystemPrompt(project.appendSystemPrompt)) },
      agentInsert,
    );
    const displayInsert = insertAfterTable(block, "projects.agent.options", block.length);
    setTableKeys(
      block,
      "projects.display",
      {
        mode: tomlString("quiet"),
        thinking_messages: "false",
        tool_messages: "false",
        reply_footer: "false",
      },
      displayInsert,
    );
    lines.splice(span.start, span.end - span.start, ...block);
  }

  const disabled = new Set<string>();
  const currentDisabled = parsed.raw.stream_preview?.disabled_platforms;
  if (Array.isArray(currentDisabled)) {
    for (const item of currentDisabled) {
      if (typeof item === "string") disabled.add(item);
    }
  }
  disabled.add("feishu");
  disabled.add("lark");
  setTableKeys(
    lines,
    "stream_preview",
    { disabled_platforms: JSON.stringify([...disabled]) },
    lines.length,
  );

  return {
    text: `${lines.join(newline)}${hadFinalNewline ? newline : ""}`,
    projects: selected.map(({ name, agentType }) => ({ name, agentType })),
  };
}
