import { statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { AgentType, ReferenceDisplayConfig } from "./types.js";

type PathKind = "file" | "directory" | "unknown";

interface PathReference {
  originalPath: string;
  absolutePath: string;
  relativePath: string;
  location: string;
  kind: PathKind;
}

interface Token {
  key: string;
  preserved?: string;
  reference?: PathReference;
}

const FENCE = /```[\s\S]*?```/g;
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)\s]+)\)((?::\d+(?::\d+)?|:\d+-\d+)?)?/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const WEB_URL = /https?:\/\/[^\s<>()]+/g;
const PATH_CANDIDATE = /(?:file:\/\/\/|\/|\.\.?\/)[^\s`<>\[\](),，、;；。！？!?]+|\b[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.@%+~-]+)+(?:#L\d+(?:C\d+)?|:\d+(?::\d+|-\d+)?)?/g;
const LOCATION = /^(.*?)(#L\d+(?:C\d+)?|:\d+(?::\d+|-\d+)?)$/;

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

function tokenKey(index: number): string {
  return `\u0000CCFP_PATH_${String(index).padStart(4, "0")}\u0000`;
}

function addPreserved(tokens: Token[], value: string): string {
  const key = tokenKey(tokens.length);
  tokens.push({ key, preserved: value });
  return key;
}

function addReference(tokens: Token[], value: PathReference): string {
  const key = tokenKey(tokens.length);
  tokens.push({ key, reference: value });
  return key;
}

function pathKind(path: string, original: string, location: string): PathKind {
  if (path) {
    try {
      return statSync(path).isDirectory() ? "directory" : "file";
    } catch {
      // A missing path can still be represented safely from its syntax.
    }
  }
  if (location || extname(original)) return "file";
  if (original.endsWith("/")) return "directory";
  return "unknown";
}

function parseReference(value: string, workspace: string): PathReference | undefined {
  let candidate = value.trim();
  if (!candidate || /^https?:\/\//i.test(candidate) || candidate.startsWith("//")) {
    return undefined;
  }

  let location = "";
  const locationMatch = candidate.match(LOCATION);
  if (locationMatch?.[1] && locationMatch[2]) {
    candidate = locationMatch[1];
    location = locationMatch[2];
  }

  if (candidate.startsWith("file://")) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    } catch {
      return undefined;
    }
  }
  if (
    !candidate.startsWith("/") &&
    !candidate.startsWith("./") &&
    !candidate.startsWith("../") &&
    !candidate.includes("/") &&
    !basename(candidate).includes(".")
  ) {
    return undefined;
  }

  const absolutePath = isAbsolute(candidate)
    ? resolve(candidate)
    : workspace
      ? resolve(workspace, candidate)
      : "";
  const relativePath = workspace && absolutePath
    ? slash(relative(workspace, absolutePath))
    : "";
  return {
    originalPath: slash(candidate),
    absolutePath: slash(absolutePath),
    relativePath,
    location,
    kind: pathKind(absolutePath, candidate, location),
  };
}

function basenameOf(reference: PathReference): string {
  return basename(reference.originalPath.replace(/\/$/, ""));
}

function compactPath(
  reference: PathReference,
  mode: string,
  duplicateBasename: boolean,
): string {
  const normalizedMode = mode.trim().toLowerCase();
  let result: string;
  if (normalizedMode === "absolute") {
    result = reference.absolutePath || reference.originalPath;
  } else if (normalizedMode === "relative") {
    result = reference.relativePath && !reference.relativePath.startsWith("../")
      ? reference.relativePath
      : reference.originalPath;
  } else {
    const clean = slash(
      reference.relativePath && !reference.relativePath.startsWith("../")
        ? reference.relativePath
        : reference.originalPath,
    ).replace(/^\.\//, "").replace(/\/$/, "");
    const segments = clean.split("/").filter(Boolean);
    const count = normalizedMode === "basename" || !duplicateBasename ? 1 : 2;
    result = segments.slice(-count).join("/") || clean;
  }
  if (reference.kind === "directory" && !result.endsWith("/")) result += "/";
  return `${result}${reference.location}`;
}

function decorate(
  body: string,
  kind: PathKind,
  config: ReferenceDisplayConfig,
): string {
  switch (config.enclosureStyle.trim().toLowerCase()) {
    case "bracket":
      body = `[${body}]`;
      break;
    case "angle":
      body = `<${body}>`;
      break;
    case "fullwidth":
      body = `【${body}】`;
      break;
    case "code":
      body = `\`${body}\``;
      break;
  }

  const marker = config.markerStyle.trim().toLowerCase();
  if (marker === "ascii") {
    if (kind === "file") return `[FILE] ${body}`;
    if (kind === "directory") return `[DIR] ${body}`;
  }
  if (marker === "emoji") {
    if (kind === "file") return `📄 ${body}`;
    if (kind === "directory") return `📁 ${body}`;
  }
  return body;
}

function resolveTokens(
  text: string,
  tokens: Token[],
  config: ReferenceDisplayConfig,
): string {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (!token.reference) continue;
    const name = basenameOf(token.reference);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const token of [...tokens].reverse()) {
    const replacement = token.reference
      ? decorate(
          compactPath(
            token.reference,
            config.displayPath,
            (counts.get(basenameOf(token.reference)) ?? 0) > 1,
          ),
          token.reference.kind,
          config,
        )
      : (token.preserved ?? "");
    text = text.replaceAll(token.key, replacement);
  }
  return text;
}

function transformText(
  text: string,
  config: ReferenceDisplayConfig,
  workspace: string,
): string {
  const tokens: Token[] = [];
  let output = text.replace(INLINE_CODE, (whole: string, content: string) => {
    const reference = parseReference(content, workspace);
    return reference ? addReference(tokens, reference) : addPreserved(tokens, whole);
  });
  output = output.replace(
    MARKDOWN_LINK,
    (whole: string, _label: string, target: string, suffix = "") => {
      if (/^https?:\/\//i.test(target)) return addPreserved(tokens, whole);
      const reference = parseReference(`${target}${suffix}`, workspace);
      return reference ? addReference(tokens, reference) : addPreserved(tokens, whole);
    },
  );
  output = output.replace(WEB_URL, (url) => addPreserved(tokens, url));
  output = output.replace(PATH_CANDIDATE, (candidate: string, offset: number, whole: string) => {
    if (offset > 0 && !/[\s([{<"'`、，,;；。！？!?:：]/u.test(whole[offset - 1] ?? "")) {
      return candidate;
    }
    const reference = parseReference(candidate, workspace);
    return reference ? addReference(tokens, reference) : candidate;
  });
  return resolveTokens(output, tokens, config);
}

function enabled(
  config: ReferenceDisplayConfig,
  agentType: AgentType,
  platform: "feishu" | "lark",
): boolean {
  const agent = agentType === "claudecode" ? "claudecode" : "codex";
  const platformName = platform === "lark" ? "feishu" : platform;
  const inScope = (values: string[], value: string) =>
    values.some((item) => {
      const normalized = item.trim().toLowerCase();
      return normalized === "all" || normalized === value;
    });
  return inScope(config.normalizeAgents, agent) &&
    inScope(config.renderPlatforms, platformName);
}

export function transformLocalReferences(
  markdown: string,
  config: ReferenceDisplayConfig | undefined,
  agentType: AgentType,
  platform: "feishu" | "lark",
  workspace: string,
): string {
  if (!config || !markdown.trim() || !enabled(config, agentType, platform)) {
    return markdown;
  }
  let output = "";
  let cursor = 0;
  for (const fenced of markdown.matchAll(FENCE)) {
    output += transformText(markdown.slice(cursor, fenced.index), config, workspace);
    output += fenced[0];
    cursor = fenced.index + fenced[0].length;
  }
  return output + transformText(markdown.slice(cursor), config, workspace);
}
