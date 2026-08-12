import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CC_DATA_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), ".cc-connect");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CC_CONFIG_PATH?.trim();
  return configured ? resolve(configured) : join(dataDir(env), "config.toml");
}

export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), "run", "api.sock");
}

export function pluginDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), "feishu-plus");
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginDataDir(env), "turns");
}

export function manifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginDataDir(env), "install-manifest.json");
}
