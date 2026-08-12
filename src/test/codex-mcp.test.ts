import assert from "node:assert/strict";
import test from "node:test";
import {
  hasCodexMcpContextEnv,
  renderCodexMcpContextEnv,
} from "../codex-mcp.js";

const CODEX_CONFIG = `# keep this comment
[mcp_servers.other]
command = "other"

[mcp_servers.feishu_plus]
command = "npm"
args = ["exec", "cc-connect-feishu-plus"]

[mcp_servers.feishu_plus.env]
CC_CONFIG_PATH = "/tmp/config.toml"
`;

test("adds CC Connect turn context to the Codex MCP environment whitelist", () => {
  const rendered = renderCodexMcpContextEnv(CODEX_CONFIG);

  assert.match(
    rendered,
    /env_vars = \["CC_PROJECT", "CC_SESSION_KEY"\]/,
  );
  assert.match(rendered, /^# keep this comment$/m);
  assert.match(rendered, /\[mcp_servers\.other\]/);
  assert.equal(hasCodexMcpContextEnv(rendered), true);
});

test("keeps an already-correct Codex MCP config byte-for-byte", () => {
  const configured = CODEX_CONFIG.replace(
    'args = ["exec", "cc-connect-feishu-plus"]',
    'args = ["exec", "cc-connect-feishu-plus"]\nenv_vars = ["CC_PROJECT", "CC_SESSION_KEY"]',
  );

  assert.equal(renderCodexMcpContextEnv(configured), configured);
});

test("fails closed when the registered MCP table is missing", () => {
  assert.throws(
    () => renderCodexMcpContextEnv('[mcp_servers.other]\ncommand = "other"\n'),
    /mcp_servers\.feishu_plus was not found/,
  );
});
