#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { CodexProxyFilter, type ProxySignal } from "./codex-proxy-protocol.js";
import { TurnService } from "./turn-service.js";

const REAL_COMMAND_FLAG = "--ccfp-real-command=";
const CONFIG_PATH_FLAG = "--ccfp-config=";
const MAX_DECISION_BUFFER_BYTES = 8 * 1024 * 1024;

interface Invocation {
  command: string;
  commandArgs: string[];
  codexArgs: string[];
  configPath?: string;
}

function decodeToken<T>(encoded: string, label: string): T {
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  } catch {
    throw new Error(`invalid ${label} installed by cc-connect-feishu-plus`);
  }
}

function parseInvocation(args: string[]): Invocation {
  let commandParts: string[] | undefined;
  let configPath: string | undefined;
  const codexArgs: string[] = [];
  for (const arg of args) {
    if (arg.startsWith(REAL_COMMAND_FLAG)) {
      commandParts = decodeToken<string[]>(
        arg.slice(REAL_COMMAND_FLAG.length),
        "real Codex command",
      );
    } else if (arg.startsWith(CONFIG_PATH_FLAG)) {
      configPath = decodeToken<string>(
        arg.slice(CONFIG_PATH_FLAG.length),
        "CC Connect config path",
      );
    } else {
      codexArgs.push(arg);
    }
  }
  if (!commandParts || commandParts.length === 0) commandParts = ["codex"];
  if (!commandParts.every((part) => typeof part === "string" && part !== "")) {
    throw new Error("real Codex command is empty");
  }
  const command = commandParts[0];
  if (!command) throw new Error("real Codex command is empty");
  return {
    command,
    commandArgs: commandParts.slice(1),
    codexArgs,
    ...(typeof configPath === "string" && configPath !== "" ? { configPath } : {}),
  };
}

function isJsonExec(args: string[]): boolean {
  return args.includes("exec") && args.includes("--json");
}

async function writeLine(line: string): Promise<void> {
  if (!process.stdout.write(`${line}\n`)) await once(process.stdout, "drain");
}

function startChild(invocation: Invocation): ChildProcessWithoutNullStreams {
  return spawn(
    invocation.command,
    [...invocation.commandArgs, ...invocation.codexArgs],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

async function childExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (typeof code === "number") resolve(code);
      else resolve(signal ? 128 : 1);
    });
  });
}

async function passthrough(invocation: Invocation): Promise<number> {
  const child = startChild(invocation);
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  return childExit(child);
}

async function handleSignal(
  signal: ProxySignal,
  service: TurnService,
): Promise<{ lines: string[]; fallback: boolean; handledFailure: boolean }> {
  if (signal.type === "activity") {
    await service.activity(signal.phase).catch(() => undefined);
    return { lines: [], fallback: false, handledFailure: false };
  }

  if (signal.type === "complete") {
    await service.activity("preparing_answer").catch(() => undefined);
    try {
      await service.complete(signal.markdown);
      return {
        lines: signal.successLines,
        fallback: false,
        handledFailure: false,
      };
    } catch {
      await service
        .fail("高级卡片更新失败，已回退到原生回答。")
        .catch(() => undefined);
      return {
        lines: signal.fallbackLines,
        fallback: true,
        handledFailure: false,
      };
    }
  }

  try {
    await service.fail(signal.message);
    return {
      lines: signal.successLines,
      fallback: false,
      handledFailure: true,
    };
  } catch {
    return {
      lines: signal.fallbackLines,
      fallback: true,
      handledFailure: false,
    };
  }
}

async function automaticCardProxy(invocation: Invocation): Promise<number> {
  if (invocation.configPath) process.env.CC_CONFIG_PATH = invocation.configPath;
  const service = new TurnService();
  const filter = new CodexProxyFilter();
  let takeover: boolean | undefined;
  let handledFailure = false;
  let bufferedBytes = 0;
  const bufferedLines: string[] = [];
  let pipeline: Promise<void> = Promise.resolve();

  const child = startChild(invocation);
  const exitPromise = childExit(child);
  process.stdin.pipe(child.stdin);
  child.stderr.pipe(process.stderr);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => child.kill(signal));
  }

  const processOwnedLine = async (line: string): Promise<void> => {
    if (!takeover) {
      await writeLine(line);
      return;
    }
    const result = filter.consume(line);
    for (const forwarded of result.forward) await writeLine(forwarded);
    if (!result.signal) return;
    const handled = await handleSignal(result.signal, service);
    for (const forwarded of handled.lines) await writeLine(forwarded);
    if (handled.fallback) takeover = false;
    if (handled.handledFailure) handledFailure = true;
  };

  const enqueue = (line: string): void => {
    pipeline = pipeline.then(() => processOwnedLine(line));
  };

  const beginDecision = service
    .begin()
    .then(async (result) => {
      if (takeover !== undefined) {
        if (!takeover && result.active) {
          await service
            .fail("回答输出过大，已回退到原生回复。")
            .catch(() => undefined);
        }
        return;
      }
      takeover = result.active;
      for (const line of bufferedLines.splice(0)) enqueue(line);
    })
    .catch(() => {
      if (takeover !== undefined) return;
      takeover = false;
      for (const line of bufferedLines.splice(0)) enqueue(line);
    });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    if (takeover === undefined) {
      bufferedLines.push(line);
      bufferedBytes += Buffer.byteLength(line) + 1;
      if (bufferedBytes > MAX_DECISION_BUFFER_BYTES) {
        takeover = false;
        for (const buffered of bufferedLines.splice(0)) enqueue(buffered);
      }
    } else {
      enqueue(line);
    }
  }

  await beginDecision;
  if (takeover === undefined) takeover = false;
  for (const line of bufferedLines.splice(0)) enqueue(line);
  await pipeline;

  const code = await exitPromise;
  if (takeover && !filter.terminalHandled) {
    await service
      .fail("Agent 进程在完成回答前意外结束，请重新发送。")
      .catch(() => undefined);
  }
  return handledFailure ? 0 : code;
}

async function main(): Promise<void> {
  const invocation = parseInvocation(process.argv.slice(2));
  const code = isJsonExec(invocation.codexArgs)
    ? await automaticCardProxy(invocation)
    : await passthrough(invocation);
  process.exitCode = code;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unexpected proxy error";
  process.stderr.write(`cc-connect-feishu-plus proxy: ${message}\n`);
  process.exitCode = 1;
});
