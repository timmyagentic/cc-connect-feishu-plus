import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TurnService } from "./turn-service.js";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : "unexpected Feishu Plus error",
      },
    ],
  };
}

export function createMcpServer(service = new TurnService()): McpServer {
  const server = new McpServer({ name: "cc-connect-feishu-plus", version: "0.1.0" });

  server.registerTool(
    "turn_begin",
    {
      title: "Begin Feishu rich-card turn",
      description:
        "Must be the first action of every CC Connect turn. Activates one quoted Feishu answer card when the current platform is Feishu/Lark.",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(await service.begin());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "turn_activity",
    {
      title: "Update safe Feishu activity",
      description:
        "Updates only a coarse safe phase. Never send reasoning, commands, paths, tool names, or tool inputs.",
      inputSchema: {
        phase: z.enum(["analyzing", "working", "verifying", "preparing_answer"]),
      },
    },
    async ({ phase }) => {
      try {
        await service.activity(phase);
        return textResult({ ok: true });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "turn_write",
    {
      title: "Append final answer text to Feishu card",
      description:
        "Appends one coherent, final-quality user-facing Markdown chunk to the same card. Use for progressive long answers. Never send reasoning, plans, shell commands, tool details, or provisional claims.",
      inputSchema: {
        markdown_delta: z.string().min(1).max(4_000),
      },
    },
    async ({ markdown_delta }) => {
      try {
        return textResult({ ok: true, ...(await service.write(markdown_delta)) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "turn_complete",
    {
      title: "Complete Feishu rich-card turn",
      description:
        "Writes the complete user-facing Markdown answer into the quoted card and marks it Done. After success, output exactly NO_REPLY.",
      inputSchema: {
        markdown: z.string().min(1).max(24_000),
      },
    },
    async ({ markdown }) => {
      try {
        await service.complete(markdown);
        return textResult({ ok: true, instruction: "Output exactly NO_REPLY." });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "turn_fail",
    {
      title: "Fail Feishu rich-card turn",
      description:
        "Marks the quoted card as not completed with a concise user-facing explanation. After success, output exactly NO_REPLY.",
      inputSchema: {
        message: z.string().min(1).max(500),
      },
    },
    async ({ message }) => {
      try {
        await service.fail(message);
        return textResult({ ok: true, instruction: "Output exactly NO_REPLY." });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
