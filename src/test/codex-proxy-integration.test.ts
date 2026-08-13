import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

function listenUnix(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
}

function listenTcp(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("test Feishu server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function collectRequestBody(request: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(response: import("node:http").ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

test("bundled proxy owns one privacy-safe card without MCP cooperation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccfp-proxy-e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, "data");
  const runDirectory = join(data, "run");
  await mkdir(runDirectory, { recursive: true });
  const socket = join(runDirectory, "api.sock");
  let sendCalls = 0;
  let placeholderSent = false;
  const ccBodies: string[] = [];
  const timeline: string[] = [];

  const ccServer = createServer(async (request, response) => {
    sendCalls += 1;
    ccBodies.push(await collectRequestBody(request));
    placeholderSent = true;
    timeline.push("native-send");
    json(response, { status: "ok" });
  });
  await listenUnix(ccServer, socket);
  t.after(() => close(ccServer));

  const cardBodies: string[] = [];
  const feishuServer = createServer(async (request, response) => {
    const url = request.url ?? "";
    if (url === "/open-apis/auth/v3/tenant_access_token/internal") {
      await collectRequestBody(request);
      json(response, { code: 0, tenant_access_token: "token", expire: 7200 });
      return;
    }
    if (request.method === "GET" && url === "/open-apis/bot/v3/info") {
      json(response, { code: 0, bot: { open_id: "ou_bot" } });
      return;
    }
    if (request.method === "GET" && url.startsWith("/open-apis/im/v1/messages?")) {
      const root = {
        message_id: "om_root",
        msg_type: "text",
        sender: { id: "ou_original", sender_type: "user" },
        body: { content: "question" },
      };
      const actualTrigger = {
        message_id: "om_actual_trigger",
        root_id: "om_root",
        msg_type: "text",
        sender: { id: "ou_requester", sender_type: "user" },
        body: { content: "actual question" },
      };
      const newerOtherParticipant = {
        message_id: "om_newer_other_participant",
        root_id: "om_root",
        msg_type: "text",
        sender: { id: "ou_other", sender_type: "user" },
        body: { content: "newer unrelated message" },
      };
      const placeholder = {
        message_id: "om_placeholder",
        parent_id: "om_actual_trigger",
        root_id: "om_root",
        msg_type: "interactive",
        sender: { id: "ou_bot", sender_type: "app" },
        body: { content: "redacted Card 2.0 body" },
      };
      json(response, {
        code: 0,
        data: {
          items: [
            ...(placeholderSent ? [placeholder] : []),
            newerOtherParticipant,
            actualTrigger,
            root,
          ],
        },
      });
      return;
    }
    if (request.method === "POST" && url === "/open-apis/cardkit/v1/cards") {
      timeline.push("direct-cardkit-create");
      cardBodies.push(await collectRequestBody(request));
      json(response, { code: 0, data: { card_id: "card_123" } });
      return;
    }
    if (
      request.method === "POST" &&
      url.startsWith("/open-apis/im/v1/messages/") &&
      url.endsWith("/reply")
    ) {
      timeline.push(`direct-reply:${url}`);
      await collectRequestBody(request);
      json(response, { code: 0, data: { message_id: "om_card" } });
      return;
    }
    if (
      request.method === "PATCH" &&
      url === "/open-apis/im/v1/messages/om_placeholder"
    ) {
      timeline.push("patch-native-message");
      cardBodies.push(await collectRequestBody(request));
      json(response, { code: 0, data: {} });
      return;
    }
    if (url.startsWith("/open-apis/cardkit/v1/cards/card_123")) {
      cardBodies.push(await collectRequestBody(request));
      json(response, { code: 0, data: {} });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const feishuPort = await listenTcp(feishuServer);
  t.after(() => close(feishuServer));

  const configPath = join(directory, "config.toml");
  await writeFile(
    configPath,
    `[[projects]]
name = "demo"

[projects.agent]
type = "codex"

[[projects.platforms]]
type = "feishu"

[projects.platforms.options]
app_id = "cli_test"
app_secret = "secret"
domain = "http://127.0.0.1:${feishuPort}"
reply_to_trigger = true
`,
    { mode: 0o600 },
  );

  const fakeCodex = join(directory, "fake-codex.mjs");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
process.stdin.resume();
  const events = [
  { type: "thread.started", thread_id: "thread_1" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "reasoning_1", type: "reasoning", text: "PRIVATE_REASONING_SENTINEL_1" } },
  { type: "item.completed", item: { id: "reasoning_2", type: "reasoning", text: "PRIVATE_REASONING_SENTINEL_2" } },
];
for (let index = 1; index <= 10; index += 1) {
  events.push({ type: "item.started", item: { id: \`tool_\${index}\`, type: "command_execution", command: \`PRIVATE_TOOL_COMMAND_SENTINEL_\${index}\` } });
  events.push({ type: "item.completed", item: { id: \`tool_\${index}\`, type: "command_execution", aggregated_output: \`PRIVATE_TOOL_OUTPUT_SENTINEL_\${index}\` } });
}
events.push(
  { type: "item.completed", item: { type: "agent_message", text: "这是最终答案。" } },
  { type: "item.completed", item: { id: "todo_1", type: "todo_list", items: [{ text: "PRIVATE_TODO_SENTINEL", completed: true }] } },
  { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } },
);
for (const event of events) console.log(JSON.stringify(event));
`,
    { mode: 0o700 },
  );
  await chmod(fakeCodex, 0o700);

  const proxy = fileURLToPath(new URL("../runtime/codex-proxy.mjs", import.meta.url));
  const args = [
    proxy,
    `--ccfp-real-command=${encoded([fakeCodex])}`,
    `--ccfp-config=${encoded(configPath)}`,
    "exec",
    "--json",
    "-",
  ];
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: directory,
        env: {
          ...process.env,
          HOME: directory,
          CC_DATA_DIR: data,
          CC_PROJECT: "demo",
          CC_SESSION_KEY: "feishu:oc_chat:root:om_root",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) =>
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
      child.stdin.end("user question");
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(sendCalls, 1);
  assert.match(ccBodies[0] ?? "", /正在思考/);
  assert.match(ccBodies[0] ?? "", /feishu:oc_chat:root:om_root/);
  assert.doesNotMatch(ccBodies[0] ?? "", /PRIVATE_/);
  assert.equal(timeline[0], "native-send");
  assert.ok(timeline.includes("patch-native-message"));
  assert.ok(timeline.every((item) => !item.startsWith("direct-")), timeline.join(", "));
  assert.match(result.stdout, /thread\.started/);
  assert.match(result.stdout, /NO_REPLY/);
  assert.doesNotMatch(result.stdout, /PRIVATE_|这是最终答案/);
  assert.ok(cardBodies.length >= 4);
  const cards = cardBodies.join("\n");
  assert.match(cards, /正在思考/);
  assert.match(cards, /正在调用工具/);
  assert.match(cards, /推理 2 次/);
  assert.match(cards, /工具 10 次/);
  assert.match(cards, /无法展开/);
  assert.match(cards, /这是最终答案/);
  assert.match(cards, /✅ Done/);
  assert.doesNotMatch(cards, /PRIVATE_REASONING|PRIVATE_TOOL/);
  assert.doesNotMatch(cards, /collapsible_panel|expanded/);
  assert.ok(cardBodies.length < 18, `unexpected card update burst: ${cardBodies.length}`);
});
