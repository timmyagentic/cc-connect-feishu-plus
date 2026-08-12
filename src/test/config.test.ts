import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "smol-toml";
import {
  FEISHU_PLUS_SYSTEM_PROMPT,
  parseConfig,
  renderConfigForInstall,
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
display_path = "smart"

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

test("parseConfig resolves credentials without exposing them in project metadata", () => {
  const parsed = parseConfig(SAMPLE, env);
  assert.equal(parsed.projects.length, 2);
  assert.equal(parsed.projects[0]?.feishu.appSecret, "resolved-secret");
  assert.equal(parsed.projects[1]?.feishu.baseUrl, "https://open.larksuite.com");
});

test("renderConfigForInstall preserves native config and adds only supported overrides", () => {
  const rendered = renderConfigForInstall(SAMPLE, {}, env);
  const parsed = parse(rendered.text) as Record<string, unknown>;
  const projects = parsed.projects as Array<Record<string, unknown>>;

  assert.equal(projects.length, 2);
  for (const project of projects) {
    const display = project.display as Record<string, unknown>;
    assert.deepEqual(
      {
        mode: display.mode,
        thinking_messages: display.thinking_messages,
        tool_messages: display.tool_messages,
        reply_footer: display.reply_footer,
      },
      {
        mode: "quiet",
        thinking_messages: false,
        tool_messages: false,
        reply_footer: false,
      },
    );
  }

  const codexOptions = (projects[0]?.agent as Record<string, unknown>)
    .options as Record<string, unknown>;
  assert.match(String(codexOptions.append_system_prompt), /Keep my existing instruction/);
  assert.match(String(codexOptions.append_system_prompt), /turn_complete/);
  assert.match(String(codexOptions.append_system_prompt), /turn_write/);
  assert.equal(
    String(codexOptions.append_system_prompt).split(FEISHU_PLUS_SYSTEM_PROMPT).length - 1,
    1,
  );

  const stream = parsed.stream_preview as Record<string, unknown>;
  assert.deepEqual(stream.disabled_platforms, ["telegram", "feishu", "lark"]);
  assert.match(rendered.text, /reply_to_trigger = true/);
  assert.equal((projects[0]?.display as Record<string, unknown>).card_mode, undefined);
  assert.equal((parsed.display as Record<string, unknown>).card_mode, "rich");
  assert.match(rendered.text, /\[log\]\nlevel = "info"/);
});

test("renderConfigForInstall is idempotent", () => {
  const once = renderConfigForInstall(SAMPLE, {}, env).text;
  const twice = renderConfigForInstall(once, {}, env).text;
  assert.equal(twice, once);
});

test("renderConfigForInstall can target one project", () => {
  const rendered = renderConfigForInstall(
    SAMPLE,
    { projectNames: ["Codex Project"] },
    env,
  );
  const parsed = parse(rendered.text) as Record<string, unknown>;
  const projects = parsed.projects as Array<Record<string, unknown>>;
  assert.ok(projects[0]?.display);
  assert.equal(projects[1]?.display, undefined);
});

test("parseConfig fails closed for an unresolved credential variable", () => {
  assert.throws(() => parseConfig(SAMPLE, {}), /unset environment variable/);
});
