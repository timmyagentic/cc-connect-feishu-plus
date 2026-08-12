#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { FeishuClient } from "../dist/feishu.js";

const configPath = process.argv[2] ?? join(process.env.HOME, ".cc-connect", "config.toml");
const dataDir = process.env.CC_DATA_DIR ?? join(process.env.HOME, ".cc-connect");

function collectSessionKeys(value, output = new Set()) {
  if (typeof value === "string") {
    if (/^(feishu|lark):[^:]+/.test(value)) output.add(value);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectSessionKeys(item, output);
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/^(feishu|lark):[^:]+/.test(key)) output.add(key);
    collectSessionKeys(item, output);
  }
  return output;
}

const parsed = await loadConfig(configPath);
const sessionFiles = await readdir(join(dataDir, "sessions"));
const reports = [];

for (const project of parsed.projects) {
  const candidates = sessionFiles.filter((file) =>
    basename(file).startsWith(`${project.name}_`),
  );
  const keys = new Set();
  for (const file of candidates) {
    const data = JSON.parse(await readFile(join(dataDir, "sessions", file), "utf8"));
    collectSessionKeys(data, keys);
  }
  const chatIds = new Set(
    [...keys]
      .map((key) => key.split(":")[1])
      .filter((value) => typeof value === "string" && value !== ""),
  );
  if (chatIds.size === 0) {
    reports.push({ project: project.name, status: "no-saved-chat" });
    continue;
  }

  const client = new FeishuClient(project.feishu);
  try {
    const recentItems = await client.checkChatHistoryAccess([...chatIds][0]);
    reports.push({
      project: project.name,
      status: "history-access-ok",
      recentItems,
    });
  } catch (error) {
    reports.push({
      project: project.name,
      status: "history-access-failed",
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown error",
    });
  }
}

console.log(JSON.stringify(reports, null, 2));
