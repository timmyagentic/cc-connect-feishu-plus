import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../mcp.js";
import type { TurnService } from "../turn-service.js";

test("MCP exposes the five-tool cooperative card contract", async (t) => {
  const calls: string[] = [];
  const service = {
    begin: async () => {
      calls.push("begin");
      return { active: true, instruction: "continue" };
    },
    activity: async () => {
      calls.push("activity");
    },
    write: async () => {
      calls.push("write");
      return { totalCharacters: 3 };
    },
    complete: async () => {
      calls.push("complete");
    },
    fail: async () => {
      calls.push("fail");
    },
  } as unknown as TurnService;
  const server = createMcpServer(service);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["turn_activity", "turn_begin", "turn_complete", "turn_fail", "turn_write"],
  );

  const begin = await client.callTool({ name: "turn_begin", arguments: {} });
  assert.equal(begin.isError, undefined);
  const write = await client.callTool({
    name: "turn_write",
    arguments: { markdown_delta: "答案" },
  });
  assert.equal(write.isError, undefined);
  assert.deepEqual(calls, ["begin", "write"]);

  const invalid = await client.callTool({
    name: "turn_activity",
    arguments: { phase: "running_bash" },
  });
  assert.equal(invalid.isError, true);
  assert.deepEqual(calls, ["begin", "write"]);
});
