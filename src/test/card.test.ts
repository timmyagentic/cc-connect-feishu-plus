import assert from "node:assert/strict";
import test from "node:test";
import {
  completedCard,
  estimatedAnimationMs,
  progressiveFrames,
  streamingCard,
  workingCard,
} from "../card.js";

test("working card exposes only a locked generic status with no expansion control", () => {
  const card = workingCard("working", { reasoningCount: 2, toolCount: 7 });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /正在调用工具/);
  assert.match(serialized, /推理 2 次/);
  assert.match(serialized, /工具 7 次/);
  assert.match(serialized, /无法展开/);
  assert.doesNotMatch(serialized, /collapsible_panel|expanded|tool_name|command/);
});

test("streaming card uses one stable answer element and adaptive typewriter config", () => {
  const card = streamingCard("一个短回答");
  assert.equal(card.schema, "2.0");
  assert.equal(card.config.streaming_mode, true);
  assert.equal(card.body.elements[0]?.element_id, "main_text");
  assert.equal(card.config.streaming_config?.print_step.default, 1);
});

test("completed card is clean and has an explicit Done state", () => {
  const card = completedCard("最终答案");
  assert.equal(card.header.title.content, "✅ Done");
  assert.equal(card.config.streaming_mode, false);
  const serialized = JSON.stringify(card);
  assert.doesNotMatch(serialized, /token|context|workdir|model/i);
  assert.doesNotMatch(serialized, /推理 \d+ 次|工具 \d+ 次/);
  assert.match(serialized, /最终答案/);
});

test("fallback frames are monotonic prefixes and bounded", () => {
  const text = "abcdefghijklmnopqrstuvwxyz";
  const frames = progressiveFrames(text, 6);
  assert.equal(frames.length, 6);
  assert.equal(frames.at(-1), text);
  for (const frame of frames) assert.ok(text.startsWith(frame));
});

test("animation duration is capped", () => {
  assert.ok(estimatedAnimationMs("short") >= 250);
  assert.equal(estimatedAnimationMs("x".repeat(100_000)), 3_000);
});
