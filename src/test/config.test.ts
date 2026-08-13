import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "smol-toml";
import {
  decodeOriginalCommand,
  parseConfig,
  renderConfigForInstall,
  stripLegacySystemPrompt,
} from "../config.js";

const SAMPLE = `[display]
mode = "compact"
card_mode = "rich"

[[projects]]
name = "Codex Project"

[projects.agent]
type = "codex"

[projects.agent.options]
append_system_prompt = "Keep my existing instruction."

[projects.references]
normalize_agents = ["codex"]
render_platforms = ["feishu"]
display_path = "smart"
marker_style = "emoji"
enclosure_style = "code"

[[projects.platforms]]
type = "feishu"

[projects.platforms.options]
app_id = "cli_codex"
app_secret = "\${FEISHU_SECRET}"
reply_to_trigger = true

[[projects]]
name = "Claude Project"

[projects.agent]
type = "claudecode"

[log]
level = "info"

[[projects.platforms]]
type = "lark"

[projects.platforms.options]
app_id = "cli_claude"
app_secret = "secret-two"

[stream_preview]
disabled_platforms = ["telegram"]
`;

const env = { FEISHU_SECRET: "resolved-secret" } as NodeJS.ProcessEnv;
const options = {
  nodeExecutablePath: "/usr/bin/node",
  runtimeExecutablePath: "/tmp/ccfp/codex-proxy.mjs",
  configPath: "/tmp/cc-connect-config.toml",
  projectNames: ["Codex Project"],
};

test("parseConfig resolves credentials and native Codex command metadata", () => {
  const parsed = parseConfig(SAMPLE, env);
  assert.equal(parsed.projects.length, 2);
  assert.equal(parsed.projects[0]?.feishu.appSecret, "resolved-secret");
  assert.equal(parsed.projects[0]?.agentCommand, "codex");
  assert.equal(parsed.projects[0]?.backend, "exec");
  assert.deepEqual(parsed.projects[0]?.references, {
    normalizeAgents: ["codex"],
    renderPlatforms: ["feishu"],
    displayPath: "smart",
    markerStyle: "emoji",
    enclosureStyle: "code",
  });
  assert.equal(parsed.projects[1]?.feishu.baseUrl, "https://open.larksuite.com");
});

test("renderConfigForInstall wires only the automatic proxy and privacy display", () => {
  const rendered = renderConfigForInstall(SAMPLE, options, env);
  const parsed = parse(rendered.text) as Record<string, unknown>;
  const projects = parsed.projects as Array<Record<string, unknown>>;
  const codex = projects[0] as Record<string, unknown>;
  const display = codex.display as Record<string, unknown>;

  assert.deepEqual(
    {
      thinking_messages: display.thinking_messages,
      tool_messages: display.tool_messages,
      show_context_indicator: display.show_context_indicator,
      reply_footer: display.reply_footer,
    },
    {
      thinking_messages: false,
      tool_messages: false,
      show_context_indicator: false,
      reply_footer: false,
    },
  );
  assert.equal(display.mode, undefined);

  const codexOptions = (codex.agent as Record<string, unknown>)
    .options as Record<string, unknown>;
  assert.match(
    String(codexOptions.cmd),
    /^\/usr\/bin\/node \/tmp\/ccfp\/codex-proxy\.mjs /,
  );
  assert.equal(decodeOriginalCommand(String(codexOptions.cmd)), "codex");
  assert.equal(codexOptions.append_system_prompt, "Keep my existing instruction.");
  assert.doesNotMatch(rendered.text, /turn_begin|turn_complete|mcp__feishu_plus/);
  assert.match(rendered.text, /reply_to_trigger = true/);
  assert.deepEqual(
    (parsed.stream_preview as Record<string, unknown>).disabled_platforms,
    ["telegram"],
  );
  assert.equal((parsed.display as Record<string, unknown>).card_mode, "rich");
  assert.equal(projects[1]?.display, undefined);
  assert.equal(rendered.projects[0]?.originalAgentCommand, "codex");
});

test("renderConfigForInstall is idempotent and does not proxy the proxy", () => {
  const once = renderConfigForInstall(SAMPLE, options, env);
  const twice = renderConfigForInstall(once.text, options, env);
  assert.equal(twice.text, once.text);
  assert.equal(twice.projects[0]?.originalAgentCommand, "codex");
});

test("default installation selects compatible Codex exec projects only", () => {
  const rendered = renderConfigForInstall(
    SAMPLE,
    {
      nodeExecutablePath: options.nodeExecutablePath,
      runtimeExecutablePath: options.runtimeExecutablePath,
      configPath: options.configPath,
    },
    env,
  );
  assert.deepEqual(rendered.projects.map((project) => project.name), ["Codex Project"]);
  const parsed = parse(rendered.text) as Record<string, unknown>;
  const projects = parsed.projects as Array<Record<string, unknown>>;
  assert.equal(projects[1]?.display, undefined);
});

test("legacy cooperative MCP prompt is removed instead of extended", () => {
  const legacy = `Keep me.\n\n<cc-connect-feishu-plus version="1">\ncall mcp__feishu_plus__turn_begin\n</cc-connect-feishu-plus>`;
  assert.equal(stripLegacySystemPrompt(legacy), "Keep me.");
});

test("unsupported Claude and app-server projects fail closed", () => {
  assert.throws(
    () =>
      renderConfigForInstall(
        SAMPLE,
        { ...options, projectNames: ["Claude Project"] },
        env,
      ),
    /supports Codex exec only/,
  );
  const appServer = SAMPLE.replace(
    'append_system_prompt = "Keep my existing instruction."',
    'backend = "app_server"',
  );
  assert.throws(
    () => renderConfigForInstall(appServer, options, env),
    /supports Codex exec only/,
  );
});

test("parseConfig fails closed for an unresolved credential variable", () => {
  assert.throws(() => parseConfig(SAMPLE, {}), /unset environment variable/);
});
