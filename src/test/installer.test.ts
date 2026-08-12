import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { install, uninstall } from "../installer.js";
import type { CommandRunner } from "../process.js";

const CONFIG = `[[projects]]
name = "demo"

[projects.agent]
type = "codex"

[[projects.platforms]]
type = "feishu"

[projects.platforms.options]
app_id = "cli_test"
app_secret = "secret"
reply_to_trigger = true
`;

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

test("dry-run describes changes without writing or registering", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccfp-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.toml");
  const binaryPath = join(directory, "cc-connect");
  await writeFile(configPath, CONFIG, { mode: 0o600 });
  await writeFile(binaryPath, "#!/bin/sh\necho 'cc-connect v1.4.1'\n", { mode: 0o755 });
  let commands = 0;
  const result = await install({
    configPath,
    dryRun: true,
    env: { HOME: directory, CC_DATA_DIR: join(directory, "data"), CC_CONNECT_BINARY: binaryPath },
    commandRunner: async () => {
      commands += 1;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.changed, true);
  assert.equal(result.hostBinary?.unchanged, true);
  assert.equal(await readFile(configPath, "utf8"), CONFIG);
  assert.equal(commands, 0);
  await assert.rejects(stat(join(directory, "data", "feishu-plus")), /ENOENT/);
});

test("install and uninstall preserve the official binary and restore exact config bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccfp-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, "data");
  const configPath = join(directory, "config.toml");
  const binaryPath = join(directory, "cc-connect");
  await writeFile(configPath, CONFIG, { mode: 0o600 });
  await writeFile(binaryPath, "#!/bin/sh\necho 'cc-connect v1.4.1'\n", { mode: 0o755 });
  const beforeBinary = digest(await readFile(binaryPath));
  const calls: string[] = [];
  let codexContextConfigured = 0;
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    return {
      code: args[1] === "get" ? 1 : 0,
      stdout: "",
      stderr: "",
    };
  };
  const env = {
    HOME: directory,
    CC_DATA_DIR: data,
    CC_CONNECT_BINARY: binaryPath,
  } as NodeJS.ProcessEnv;

  const result = await install({
    configPath,
    env,
    commandRunner: runner,
    configureCodexContextEnv: async () => {
      codexContextConfigured += 1;
      return { path: join(directory, ".codex", "config.toml"), changed: true };
    },
  });
  assert.equal(result.hostBinary?.unchanged, true);
  assert.match(await readFile(configPath, "utf8"), /turn_complete/);
  assert.match(await readFile(configPath, "utf8"), /reply_to_trigger = true/);
  assert.equal(digest(await readFile(binaryPath)), beforeBinary);
  assert.ok(calls.some((call) => call.includes("codex mcp add feishu_plus")));
  assert.equal(codexContextConfigured, 1);
  const backup = await readFile(result.backupPath ?? "", "utf8");
  assert.equal(backup, CONFIG);
  assert.equal((await stat(result.backupPath ?? "")).mode & 0o777, 0o600);

  await uninstall({ env, commandRunner: runner });
  assert.equal(await readFile(configPath, "utf8"), CONFIG);
  assert.equal(digest(await readFile(binaryPath)), beforeBinary);
  assert.ok(calls.some((call) => call.includes("codex mcp remove feishu_plus")));
  await assert.rejects(stat(join(data, "feishu-plus", "install-manifest.json")), /ENOENT/);
});

test("uninstall refuses to clobber config edited after installation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccfp-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, "data");
  const configPath = join(directory, "config.toml");
  const binaryPath = join(directory, "cc-connect");
  await writeFile(configPath, CONFIG, { mode: 0o600 });
  await writeFile(binaryPath, "#!/bin/sh\necho 'cc-connect v1.4.1'\n", { mode: 0o755 });
  const runner: CommandRunner = async (_command, args) => ({
    code: args[1] === "get" ? 1 : 0,
    stdout: "",
    stderr: "",
  });
  const env = { HOME: directory, CC_DATA_DIR: data, CC_CONNECT_BINARY: binaryPath };
  await install({
    configPath,
    env,
    commandRunner: runner,
    configureCodexContextEnv: async () => ({
      path: join(directory, ".codex", "config.toml"),
      changed: true,
    }),
  });
  await writeFile(configPath, `${await readFile(configPath, "utf8")}\n# user edit\n`);
  await assert.rejects(
    uninstall({ env, commandRunner: runner }),
    /refusing to overwrite user changes/,
  );
  assert.match(await readFile(configPath, "utf8"), /# user edit/);
});

test("reinstall upgrades the pinned MCP runtime and preserves the original backup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccfp-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, "data");
  const configPath = join(directory, "config.toml");
  const binaryPath = join(directory, "cc-connect");
  await writeFile(configPath, CONFIG, { mode: 0o600 });
  await writeFile(binaryPath, "#!/bin/sh\necho 'cc-connect v1.4.1'\n", { mode: 0o755 });
  const calls: string[] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    return { code: args[1] === "get" ? 1 : 0, stdout: "", stderr: "" };
  };
  const env = {
    HOME: directory,
    CC_DATA_DIR: data,
    CC_CONNECT_BINARY: binaryPath,
  } as NodeJS.ProcessEnv;
  const configureCodexContextEnv = async () => ({
    path: join(directory, ".codex", "config.toml"),
    changed: true,
  });

  const initial = await install({
    configPath,
    env,
    commandRunner: runner,
    configureCodexContextEnv,
  });
  const manifestPath = join(data, "feishu-plus", "install-manifest.json");
  const oldManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    packageVersion: string;
  };
  oldManifest.packageVersion = "0.1.1";
  await writeFile(manifestPath, `${JSON.stringify(oldManifest, null, 2)}\n`, {
    mode: 0o600,
  });
  calls.length = 0;

  const upgraded = await install({
    configPath,
    env,
    commandRunner: runner,
    configureCodexContextEnv,
    codexContextEnvIsConfigured: async () => true,
  });

  assert.equal(upgraded.changed, true);
  assert.equal(upgraded.backupPath, initial.backupPath);
  assert.ok(calls.some((call) => call.includes("codex mcp remove feishu_plus")));
  assert.ok(
    calls.some((call) =>
      call.includes("--package=github:timmyagentic/cc-connect-feishu-plus#v0.1.2"),
    ),
  );
  const currentManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    packageVersion: string;
    updatedAt?: string;
  };
  assert.equal(currentManifest.packageVersion, "0.1.2");
  assert.ok(currentManifest.updatedAt);
});
