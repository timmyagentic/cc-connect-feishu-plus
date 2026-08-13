import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { install, uninstall } from "../installer.js";
import { PACKAGE_VERSION } from "../version.js";

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

const MULTI_PROJECT_CONFIG = `${CONFIG}
[[projects]]
name = "other"

[projects.agent]
type = "codex"

[[projects.platforms]]
type = "feishu"

[projects.platforms.options]
app_id = "cli_other"
app_secret = "secret"
reply_to_trigger = true
`;

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(prefix: string, config = CONFIG): Promise<{
  directory: string;
  data: string;
  configPath: string;
  binaryPath: string;
  runtimeSourcePath: string;
  env: NodeJS.ProcessEnv;
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const data = join(directory, "data");
  const configPath = join(directory, "config.toml");
  const binaryPath = join(directory, "cc-connect");
  const runtimeSourcePath = join(directory, "codex-proxy.mjs");
  await writeFile(configPath, config, { mode: 0o600 });
  await writeFile(binaryPath, "#!/bin/sh\necho 'cc-connect v1.4.1'\n", {
    mode: 0o755,
  });
  await writeFile(runtimeSourcePath, "#!/usr/bin/env node\n// bundled proxy\n", {
    mode: 0o700,
  });
  return {
    directory,
    data,
    configPath,
    binaryPath,
    runtimeSourcePath,
    env: {
      HOME: directory,
      CC_DATA_DIR: data,
      CC_CONNECT_BINARY: binaryPath,
    },
  };
}

test("dry-run describes proxy wiring without writing anything", async (t) => {
  const item = await fixture("ccfp-install-");
  t.after(() => rm(item.directory, { recursive: true, force: true }));
  const result = await install({
    configPath: item.configPath,
    dryRun: true,
    env: item.env,
    runtimeSourcePath: item.runtimeSourcePath,
  });
  assert.equal(result.changed, true);
  assert.equal(result.hostBinary?.unchanged, true);
  assert.equal(await readFile(item.configPath, "utf8"), CONFIG);
  assert.match(result.runtimeExecutablePath, /feishu-plus\/runtime\/v0\.2\.2/);
  await assert.rejects(stat(join(item.data, "feishu-plus")), /ENOENT/);
});

test("install and uninstall preserve official binary and exact config bytes", async (t) => {
  const item = await fixture("ccfp-install-");
  t.after(() => rm(item.directory, { recursive: true, force: true }));
  const beforeBinary = digest(await readFile(item.binaryPath));

  const result = await install({
    configPath: item.configPath,
    env: item.env,
    runtimeSourcePath: item.runtimeSourcePath,
  });
  const installedConfig = await readFile(item.configPath, "utf8");
  assert.equal(result.hostBinary?.unchanged, true);
  assert.match(installedConfig, /codex-proxy\.mjs/);
  assert.ok(installedConfig.includes(process.execPath));
  assert.match(installedConfig, /thinking_messages = false/);
  assert.doesNotMatch(installedConfig, /MCP|mcp__feishu_plus|turn_complete/);
  assert.match(installedConfig, /reply_to_trigger = true/);
  assert.equal(digest(await readFile(item.binaryPath)), beforeBinary);
  assert.equal(await readFile(result.backupPath ?? "", "utf8"), CONFIG);
  assert.equal((await stat(result.backupPath ?? "")).mode & 0o777, 0o600);
  assert.equal((await stat(result.runtimeExecutablePath)).mode & 0o777, 0o700);

  const manifest = JSON.parse(
    await readFile(join(item.data, "feishu-plus", "install-manifest.json"), "utf8"),
  ) as {
    version: number;
    nodeExecutablePath: string;
    projects: Array<{ originalAgentCommand: string }>;
  };
  assert.equal(manifest.version, 2);
  assert.equal(manifest.nodeExecutablePath, process.execPath);
  assert.equal(manifest.projects[0]?.originalAgentCommand, "codex");

  await uninstall({ env: item.env });
  assert.equal(await readFile(item.configPath, "utf8"), CONFIG);
  assert.equal(digest(await readFile(item.binaryPath)), beforeBinary);
  await assert.rejects(stat(result.runtimeExecutablePath), /ENOENT/);
  await assert.rejects(
    stat(join(item.data, "feishu-plus", "install-manifest.json")),
    /ENOENT/,
  );
});

test("uninstall refuses to clobber config edited after installation", async (t) => {
  const item = await fixture("ccfp-install-");
  t.after(() => rm(item.directory, { recursive: true, force: true }));
  await install({
    configPath: item.configPath,
    env: item.env,
    runtimeSourcePath: item.runtimeSourcePath,
  });
  await writeFile(
    item.configPath,
    `${await readFile(item.configPath, "utf8")}\n# user edit\n`,
  );
  await assert.rejects(
    uninstall({ env: item.env }),
    /refusing to overwrite user changes/,
  );
  assert.match(await readFile(item.configPath, "utf8"), /# user edit/);
});

test("reinstall repairs a missing proxy runtime without touching the backup", async (t) => {
  const item = await fixture("ccfp-repair-");
  t.after(() => rm(item.directory, { recursive: true, force: true }));
  const initial = await install({
    configPath: item.configPath,
    env: item.env,
    runtimeSourcePath: item.runtimeSourcePath,
  });
  await rm(initial.runtimeExecutablePath);

  const repaired = await install({
    configPath: item.configPath,
    env: item.env,
    runtimeSourcePath: item.runtimeSourcePath,
  });
  assert.equal(repaired.changed, true);
  assert.equal(repaired.backupPath, initial.backupPath);
  assert.equal((await stat(repaired.runtimeExecutablePath)).mode & 0o777, 0o700);
});

test("scoped patch upgrade preserves every installed project and rewires atomically", async (t) => {
  const item = await fixture("ccfp-upgrade-", MULTI_PROJECT_CONFIG);
  t.after(() => rm(item.directory, { recursive: true, force: true }));
  const initial = await install({
    configPath: item.configPath,
    env: item.env,
    runtimeSourcePath: item.runtimeSourcePath,
  });
  const manifestPath = join(item.data, "feishu-plus", "install-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    packageVersion: string;
    configAfterSha256: string;
    runtimeExecutablePath: string;
    runtimeExecutableSha256: string;
    projects: Array<{ name: string }>;
  };
  assert.deepEqual(
    manifest.projects.map((project) => project.name),
    ["demo", "other"],
  );
  const oldRuntimePath = initial.runtimeExecutablePath.replace(
    `v${PACKAGE_VERSION}`,
    "v0.2.1",
  );
  await mkdir(dirname(oldRuntimePath), { recursive: true });
  const oldRuntime = "#!/usr/bin/env node\n// old proxy\n";
  await writeFile(oldRuntimePath, oldRuntime, { mode: 0o700 });
  const oldConfig = (await readFile(item.configPath, "utf8")).replaceAll(
    initial.runtimeExecutablePath,
    oldRuntimePath,
  );
  await writeFile(item.configPath, oldConfig, { mode: 0o600 });
  await rm(dirname(initial.runtimeExecutablePath), {
    recursive: true,
    force: true,
  });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        packageVersion: "0.2.1",
        configAfterSha256: digest(oldConfig),
        runtimeExecutablePath: oldRuntimePath,
        runtimeExecutableSha256: digest(oldRuntime),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const upgraded = await install({
    configPath: item.configPath,
    env: item.env,
    runtimeSourcePath: item.runtimeSourcePath,
    projectNames: ["demo"],
  });
  const upgradedManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    packageVersion: string;
    backupPath: string;
    projects: Array<{ name: string }>;
  };
  assert.equal(upgraded.changed, true);
  assert.equal(upgraded.backupPath, initial.backupPath);
  assert.equal(upgradedManifest.packageVersion, PACKAGE_VERSION);
  assert.deepEqual(
    upgraded.projects.map((project) => project.name),
    ["demo", "other"],
  );
  assert.deepEqual(
    upgradedManifest.projects.map((project) => project.name),
    ["demo", "other"],
  );
  const upgradedConfig = await readFile(item.configPath, "utf8");
  assert.equal(upgradedConfig.match(/runtime\/v0\.2\.2/g)?.length, 2);
  assert.doesNotMatch(upgradedConfig, /runtime\/v0\.2\.1/);
  await assert.rejects(stat(oldRuntimePath), /ENOENT/);

  await uninstall({ env: item.env });
  assert.equal(await readFile(item.configPath, "utf8"), MULTI_PROJECT_CONFIG);
});

test("legacy MCP registration fails closed", async (t) => {
  const item = await fixture("ccfp-legacy-");
  t.after(() => rm(item.directory, { recursive: true, force: true }));
  await assert.rejects(
    install({
      configPath: item.configPath,
      env: item.env,
      runtimeSourcePath: item.runtimeSourcePath,
      legacyMcpConfigured: async () => true,
    }),
    /legacy Codex MCP registration/,
  );
});
