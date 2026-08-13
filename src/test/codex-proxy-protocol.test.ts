import assert from "node:assert/strict";
import test from "node:test";
import {
  ActivityUpdateGate,
  CodexProxyFilter,
  type ActivitySignal,
} from "../codex-proxy-protocol.js";

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
    item: {
      id: "reasoning_1",
      type: "reasoning",
      text: "PRIVATE_REASONING_SENTINEL",
    },
  });
  assert.deepEqual(filter.consume(reasoning), {
    forward: [],
    signal: {
      type: "activity",
      phase: "analyzing",
      source: "reasoning",
      progress: { reasoningCount: 1, toolCount: 0 },
    },
  });

  const toolStart = filter.consume(
    line({
      type: "item.started",
      item: {
        id: "tool_1",
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
    toolStart.signal?.type === "activity" ? toolStart.signal.progress : undefined,
    { reasoningCount: 1, toolCount: 1 },
  );
  assert.deepEqual(
    filter.consume(
      line({
        type: "item.completed",
        item: {
          id: "tool_1",
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

test("anonymous reasoning and tool counters are monotonic and deduplicate item lifecycle pairs", () => {
  const filter = new CodexProxyFilter();
  const signals: ActivitySignal[] = [];
  const consume = (value: unknown): void => {
    const signal = filter.consume(line(value)).signal;
    if (signal?.type === "activity") signals.push(signal);
  };

  consume({
    type: "item.completed",
    item: { id: "reasoning_1", type: "reasoning", text: "PRIVATE_R1" },
  });
  consume({
    type: "item.completed",
    item: { id: "reasoning_1", type: "reasoning", text: "PRIVATE_R1_DUPLICATE" },
  });
  consume({
    type: "item.completed",
    item: { id: "reasoning_2", type: "reasoning", text: "PRIVATE_R2" },
  });
  consume({
    type: "item.started",
    item: { id: "tool_1", type: "command_execution", command: "PRIVATE_T1" },
  });
  consume({
    type: "item.completed",
    item: { id: "tool_1", type: "command_execution", output: "PRIVATE_T1_OUT" },
  });
  consume({
    type: "item.completed",
    item: { id: "tool_2", type: "web_search", query: "PRIVATE_T2" },
  });
  consume({
    type: "item.started",
    item: { type: "mcp_tool_call", arguments: "PRIVATE_T3" },
  });
  consume({
    type: "item.completed",
    item: { type: "mcp_tool_call", result: "PRIVATE_T3_OUT" },
  });
  consume({
    type: "item.started",
    item: { id: "tool_4", type: "command_execution", command: "PRIVATE_T4" },
  });
  consume({
    type: "item.completed",
    item: { type: "command_execution", output: "PRIVATE_T4_OUT_WITHOUT_ID" },
  });
  consume({
    type: "item.started",
    item: { type: "web_search", query: "PRIVATE_T5_WITHOUT_ID" },
  });
  consume({
    type: "item.completed",
    item: { id: "tool_5", type: "web_search", result: "PRIVATE_T5_OUT" },
  });

  assert.deepEqual(
    signals.map(({ phase, source, progress }) => ({ phase, source, progress })),
    [
      {
        phase: "analyzing",
        source: "reasoning",
        progress: { reasoningCount: 1, toolCount: 0 },
      },
      {
        phase: "analyzing",
        source: "reasoning",
        progress: { reasoningCount: 2, toolCount: 0 },
      },
      {
        phase: "working",
        source: "tool",
        progress: { reasoningCount: 2, toolCount: 1 },
      },
      {
        phase: "working",
        source: "tool",
        progress: { reasoningCount: 2, toolCount: 2 },
      },
      {
        phase: "working",
        source: "tool",
        progress: { reasoningCount: 2, toolCount: 3 },
      },
      {
        phase: "working",
        source: "tool",
        progress: { reasoningCount: 2, toolCount: 4 },
      },
      {
        phase: "working",
        source: "tool",
        progress: { reasoningCount: 2, toolCount: 5 },
      },
    ],
  );
});

test("activity update gate keeps early feedback, coalesces bursts, and refreshes slow tools", () => {
  let now = 10_000;
  const gate = new ActivityUpdateGate(1_000, () => now);
  const tool = (toolCount: number): ActivitySignal => ({
    type: "activity",
    phase: "working",
    source: "tool",
    progress: { reasoningCount: 0, toolCount },
  });

  for (let count = 1; count <= 5; count += 1) {
    assert.equal(gate.shouldPublish(tool(count)), true);
  }
  assert.equal(gate.shouldPublish(tool(6)), false);
  assert.equal(gate.shouldPublish(tool(9)), false);
  assert.equal(gate.shouldPublish(tool(10)), true);
  assert.equal(gate.shouldPublish(tool(21)), false);
  assert.equal(gate.shouldPublish(tool(30)), true);

  now += 1_000;
  assert.equal(gate.shouldPublish(tool(31)), true);
  assert.equal(
    gate.shouldPublish({
      type: "activity",
      phase: "analyzing",
      source: "reasoning",
      progress: { reasoningCount: 1, toolCount: 31 },
    }),
    false,
  );
  now += 1_000;
  assert.equal(
    gate.shouldPublish({
      type: "activity",
      phase: "analyzing",
      source: "reasoning",
      progress: { reasoningCount: 2, toolCount: 31 },
    }),
    true,
  );
});

test("activity update gate coalesces rapid alternating reasoning and tool events", () => {
  const gate = new ActivityUpdateGate(1_000, () => 10_000);
  const published: Array<{ reasoningCount: number; toolCount: number }> = [];

  for (let count = 1; count <= 5; count += 1) {
    const reasoning: ActivitySignal = {
      type: "activity",
      phase: "analyzing",
      source: "reasoning",
      progress: { reasoningCount: count, toolCount: count - 1 },
    };
    if (gate.shouldPublish(reasoning)) published.push(reasoning.progress);

    const toolSignal: ActivitySignal = {
      type: "activity",
      phase: "working",
      source: "tool",
      progress: { reasoningCount: count, toolCount: count },
    };
    if (gate.shouldPublish(toolSignal)) published.push(toolSignal.progress);
  }

  assert.deepEqual(published, [
    { reasoningCount: 1, toolCount: 0 },
    { reasoningCount: 1, toolCount: 1 },
    { reasoningCount: 2, toolCount: 1 },
    { reasoningCount: 2, toolCount: 2 },
    { reasoningCount: 3, toolCount: 2 },
    { reasoningCount: 5, toolCount: 5 },
  ]);
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
