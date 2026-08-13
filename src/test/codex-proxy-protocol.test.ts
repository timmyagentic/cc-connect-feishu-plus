import assert from "node:assert/strict";
import test from "node:test";
import { CodexProxyFilter } from "../codex-proxy-protocol.js";

function line(value: unknown): string {
  return JSON.stringify(value);
}

test("reasoning and tool details are dropped while final answer becomes one silent host turn", () => {
  const filter = new CodexProxyFilter();
  const forwarded: string[] = [];
  const lifecycle = [
    line({ type: "thread.started", thread_id: "thread_1" }),
    line({ type: "turn.started" }),
  ];
  for (const item of lifecycle) forwarded.push(...filter.consume(item).forward);

  const reasoning = line({
    type: "item.completed",
    item: { type: "reasoning", text: "PRIVATE_REASONING_SENTINEL" },
  });
  assert.deepEqual(filter.consume(reasoning), { forward: [] });

  const toolStart = filter.consume(
    line({
      type: "item.started",
      item: {
        type: "command_execution",
        command: "PRIVATE_TOOL_COMMAND_SENTINEL",
      },
    }),
  );
  assert.equal(toolStart.signal?.type, "activity");
  assert.equal(
    toolStart.signal?.type === "activity" ? toolStart.signal.phase : undefined,
    "working",
  );
  assert.deepEqual(
    filter.consume(
      line({
        type: "item.completed",
        item: {
          type: "command_execution",
          aggregated_output: "PRIVATE_TOOL_OUTPUT_SENTINEL",
        },
      }),
    ),
    { forward: [] },
  );

  filter.consume(
    line({
      type: "item.completed",
      item: {
        type: "agent_message",
        content: [{ type: "output_text", text: "这是最终答案。" }],
      },
    }),
  );
  const completion = filter.consume(
    line({ type: "turn.completed", usage: { input_tokens: 10 } }),
  );
  assert.equal(completion.signal?.type, "complete");
  if (completion.signal?.type !== "complete") assert.fail("missing completion signal");
  assert.equal(completion.signal.markdown, "这是最终答案。");
  assert.match(completion.signal.successLines.join("\n"), /NO_REPLY/);
  assert.doesNotMatch(
    [...forwarded, ...completion.signal.successLines].join("\n"),
    /PRIVATE_REASONING|PRIVATE_TOOL|最终答案/,
  );
  assert.equal(filter.terminalHandled, true);
});

test("an agent message before a tool is treated as private intermediate text", () => {
  const filter = new CodexProxyFilter();
  filter.consume(
    line({
      type: "item.completed",
      item: { type: "agent_message", text: "中间解释，不应成为最终答案" },
    }),
  );
  filter.consume(
    line({ type: "item.started", item: { type: "web_search", query: "secret" } }),
  );
  filter.consume(
    line({
      type: "item.completed",
      item: { type: "agent_message", text: "真正的最终答案" },
    }),
  );
  const result = filter.consume(line({ type: "turn.completed" }));
  assert.equal(
    result.signal?.type === "complete" ? result.signal.markdown : undefined,
    "真正的最终答案",
  );
});

test("handled failure replaces raw error details with a silent native completion", () => {
  const filter = new CodexProxyFilter();
  const result = filter.consume(
    line({
      type: "turn.failed",
      error: { message: "PRIVATE_FAILURE_DETAIL" },
    }),
  );
  assert.equal(result.signal?.type, "failed");
  if (result.signal?.type !== "failed") assert.fail("missing failure signal");
  assert.match(result.signal.successLines.join("\n"), /NO_REPLY|turn\.completed/);
  assert.doesNotMatch(result.signal.successLines.join("\n"), /PRIVATE_FAILURE_DETAIL/);
  assert.match(result.signal.fallbackLines.join("\n"), /PRIVATE_FAILURE_DETAIL/);
});

test("a successful turn without a final message closes the card as a generic failure", () => {
  const filter = new CodexProxyFilter();
  const result = filter.consume(
    line({ type: "turn.completed", usage: { input_tokens: 10 } }),
  );
  assert.equal(result.signal?.type, "failed");
  if (result.signal?.type !== "failed") assert.fail("missing failure signal");
  assert.match(result.signal.message, /未返回可展示的最终答案/);
  assert.match(result.signal.successLines.join("\n"), /NO_REPLY|turn\.completed/);
  assert.equal(filter.terminalHandled, true);
});

test("non-JSON stdout remains byte compatible", () => {
  const filter = new CodexProxyFilter();
  assert.deepEqual(filter.consume("not-json"), { forward: ["not-json"] });
});
