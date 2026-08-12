import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { renderConfigForInstall } from "../config.js";

const execFileAsync = promisify(execFile);
const liveConfig = process.env.CCFP_LIVE_CONFIG;
const ccBinary = process.env.CC_CONNECT_BINARY;

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

test(
  "rendered live config is accepted by the installed official CC Connect parser",
  { skip: !liveConfig || !ccBinary },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "ccfp-live-config-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const originalConfig = await readFile(liveConfig!);
    const originalBinary = await readFile(ccBinary!);
    const candidate = join(directory, "config.toml");
    const runtime = join(directory, "codex-proxy.mjs");
    await writeFile(runtime, "#!/usr/bin/env node\n", { mode: 0o700 });
    const rendered = renderConfigForInstall(originalConfig.toString("utf8"), {
      nodeExecutablePath: process.execPath,
      runtimeExecutablePath: runtime,
      configPath: candidate,
    });
    await writeFile(candidate, rendered.text, { mode: 0o600 });

    await execFileAsync(ccBinary!, ["config", "fmt", "--config", candidate], {
      timeout: 10_000,
    });

    assert.equal(digest(await readFile(liveConfig!)), digest(originalConfig));
    assert.equal(digest(await readFile(ccBinary!)), digest(originalBinary));
  },
);
