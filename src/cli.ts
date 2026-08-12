#!/usr/bin/env node
import { doctor } from "./doctor.js";
import { install, uninstall } from "./installer.js";
import { runMcpServer } from "./mcp.js";
import { PACKAGE_VERSION } from "./version.js";

function usage(): string {
  return `CC Connect Feishu Plus ${PACKAGE_VERSION}

Usage:
  cc-connect-feishu-plus install [--dry-run] [--project NAME ...] [--config PATH]
  cc-connect-feishu-plus doctor [--json] [--config PATH]
  cc-connect-feishu-plus uninstall
  cc-connect-feishu-plus mcp

The installer changes supported configuration only. It never writes the
official CC Connect source or binary and never starts a Feishu event socket.`;
}

function valueAfter(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${args[index]} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command === "--version" || command === "version") {
    console.log(PACKAGE_VERSION);
    return;
  }
  if (command === "mcp") {
    await runMcpServer();
    return;
  }
  if (command === "install") {
    let dryRun = false;
    let configPath: string | undefined;
    const projectNames: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--dry-run") dryRun = true;
      else if (arg === "--config") {
        configPath = valueAfter(args, index);
        index += 1;
      } else if (arg === "--project") {
        projectNames.push(valueAfter(args, index));
        index += 1;
      } else {
        throw new Error(`unknown install option: ${arg}`);
      }
    }
    const result = await install({
      dryRun,
      ...(configPath ? { configPath } : {}),
      ...(projectNames.length ? { projectNames } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!dryRun) {
      console.log("\nInstallation complete. Start a new CC Connect agent session to apply the prompt.");
    }
    return;
  }
  if (command === "doctor") {
    let asJson = false;
    let configPath: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--json") asJson = true;
      else if (arg === "--config") {
        configPath = valueAfter(args, index);
        index += 1;
      } else throw new Error(`unknown doctor option: ${arg}`);
    }
    const report = await doctor(process.env, configPath);
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else {
      for (const check of report.checks) {
        console.log(`${check.ok ? "PASS" : "WARN"}  ${check.name}: ${check.detail}`);
      }
      console.log(
        "PASS  host-boundary: no source patch, no binary write, no second Feishu event connection",
      );
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "uninstall") {
    if (args.length) throw new Error("uninstall does not accept options");
    const result = await uninstall();
    console.log("CC Connect config restored and Feishu Plus MCP registrations removed.");
    for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
    return;
  }
  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
