import type { ActivityPhase } from "./types.js";

export interface CardDocument {
  schema: "2.0";
  config: {
    update_multi: true;
    streaming_mode: boolean;
    summary: { content: string };
    streaming_config?: {
      print_frequency_ms: Record<"default" | "android" | "ios" | "pc", number>;
      print_step: Record<"default" | "android" | "ios" | "pc", number>;
      print_strategy: "fast";
    };
  };
  header: {
    template: "blue" | "green" | "red";
    title: { tag: "plain_text"; content: string };
  };
  body: {
    direction: "vertical";
    padding: string;
    elements: Array<Record<string, unknown>>;
  };
}

const PHASE_LABELS: Record<ActivityPhase, string> = {
  analyzing: "正在理解问题…",
  working: "正在处理…",
  verifying: "正在核对结果…",
  preparing_answer: "正在整理回答…",
};

export function phaseLabel(phase: ActivityPhase): string {
  return PHASE_LABELS[phase];
}

function adaptivePrintStep(markdown: string): number {
  const length = [...markdown].length;
  if (length <= 100) return 1;
  if (length <= 400) return 2;
  return Math.max(3, Math.ceil(length / 160));
}

function streamConfig(
  markdown: string,
): NonNullable<CardDocument["config"]["streaming_config"]> {
  const step = adaptivePrintStep(markdown);
  return {
    print_frequency_ms: { default: 45, android: 45, ios: 45, pc: 45 },
    print_step: { default: step, android: step, ios: step, pc: step },
    print_strategy: "fast",
  };
}

function answerElement(markdown: string): Record<string, unknown> {
  return {
    tag: "markdown",
    element_id: "main_text",
    content: markdown || " ",
    text_align: "left",
    text_size: "normal",
  };
}

export function workingCard(phase: ActivityPhase): CardDocument {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: false,
      summary: { content: phaseLabel(phase) },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: `⏳ ${phaseLabel(phase)}` },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [answerElement("正在为你准备回答。")],
    },
  };
}

export function streamingCard(
  markdown: string,
  visibleMarkdown = " ",
): CardDocument {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: true,
      summary: { content: "正在生成回答" },
      streaming_config: streamConfig(markdown),
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "✍️ 正在回答" },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [answerElement(visibleMarkdown)],
    },
  };
}

export function completedCard(markdown: string): CardDocument {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: false,
      summary: { content: markdown.slice(0, 120) || "Done" },
    },
    header: {
      template: "green",
      title: { tag: "plain_text", content: "✅ Done" },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [answerElement(markdown)],
    },
  };
}

export function partialCard(markdown: string): CardDocument {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: false,
      summary: { content: "正在生成回答" },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "✍️ 正在回答" },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [answerElement(markdown)],
    },
  };
}

export function failedCard(message: string): CardDocument {
  const safe = message.trim() || "本次处理未能完成，请稍后重试。";
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: false,
      summary: { content: "处理失败" },
    },
    header: {
      template: "red",
      title: { tag: "plain_text", content: "⚠️ 未完成" },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [answerElement(safe)],
    },
  };
}

export function estimatedAnimationMs(markdown: string): number {
  const characters = [...markdown].length;
  const step = adaptivePrintStep(markdown);
  return Math.min(3_000, Math.max(250, Math.ceil(characters / step) * 45));
}

export function progressiveFrames(markdown: string, maximum = 20): string[] {
  const characters = [...markdown];
  if (characters.length === 0) return [" "];
  const count = Math.min(maximum, characters.length);
  const frames: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const end = Math.ceil((characters.length * index) / count);
    const frame = characters.slice(0, end).join("");
    if (frame !== frames.at(-1)) frames.push(frame);
  }
  return frames;
}
