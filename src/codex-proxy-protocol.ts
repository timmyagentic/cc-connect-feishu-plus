import type { ActivityPhase } from "./types.js";

export interface CompleteSignal {
  type: "complete";
  markdown: string;
  successLines: string[];
  fallbackLines: string[];
}

export interface ActivitySignal {
  type: "activity";
  phase: ActivityPhase;
}

export interface FailedSignal {
  type: "failed";
  message: string;
  successLines: string[];
  fallbackLines: string[];
}

export type ProxySignal = CompleteSignal | ActivitySignal | FailedSignal;

export interface FilterResult {
  forward: string[];
  signal?: ProxySignal;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function itemText(item: Record<string, unknown>): string {
  const content = item.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const value of content) {
      const element = record(value);
      if (!element) continue;
      if (element.type !== "output_text") continue;
      if (typeof element.text === "string" && element.text !== "") {
        parts.push(element.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return typeof item.text === "string" ? item.text : "";
}

function silentAgentLine(): string {
  return JSON.stringify({
    type: "item.completed",
    item: {
      id: "cc-connect-feishu-plus-silent",
      type: "agent_message",
      text: "NO_REPLY",
    },
  });
}

function syntheticTurnCompleted(): string {
  return JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
    },
  });
}

function isMessageItem(type: unknown): boolean {
  return type === "agent_message" || type === "message";
}

/**
 * Converts a raw Codex exec JSONL stream into a privacy-safe stream for
 * CC Connect. Raw reasoning and tool items are never forwarded while the
 * plugin owns the Feishu card. Only thread/turn lifecycle metadata and a
 * synthetic NO_REPLY completion reach the host.
 */
export class CodexProxyFilter {
  private pendingFinalText: string[] = [];
  private pendingFinalLines: string[] = [];
  private activityEmitted = false;
  private terminal = false;

  get terminalHandled(): boolean {
    return this.terminal;
  }

  private clearPendingFinal(): void {
    this.pendingFinalText = [];
    this.pendingFinalLines = [];
  }

  private activity(): FilterResult {
    this.clearPendingFinal();
    if (this.activityEmitted) return { forward: [] };
    this.activityEmitted = true;
    return {
      forward: [],
      signal: { type: "activity", phase: "working" },
    };
  }

  consume(line: string): FilterResult {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      const value = record(parsed);
      if (!value) return { forward: [line] };
      event = value;
    } catch {
      return { forward: [line] };
    }

    const eventType = event.type;
    if (eventType === "item.started") {
      const item = record(event.item);
      const itemType = item?.type;
      if (isMessageItem(itemType) || itemType === "reasoning") {
        return { forward: [] };
      }
      return this.activity();
    }

    if (eventType === "item.completed") {
      const item = record(event.item);
      const itemType = item?.type;
      if (!item) return { forward: [] };
      if (isMessageItem(itemType)) {
        const text = itemText(item);
        if (text !== "") {
          this.pendingFinalText.push(text);
          this.pendingFinalLines.push(line);
        }
        return { forward: [] };
      }
      if (itemType === "reasoning" || itemType === "error") {
        return { forward: [] };
      }
      return this.activity();
    }

    if (eventType === "turn.completed") {
      this.terminal = true;
      const markdown = this.pendingFinalText.join("\n\n").trim();
      const fallbackLines = [...this.pendingFinalLines, line];
      this.clearPendingFinal();
      if (markdown === "") {
        return {
          forward: [],
          signal: {
            type: "failed",
            message: "Agent 未返回可展示的最终答案，请重新发送。",
            successLines: [silentAgentLine(), line],
            fallbackLines,
          },
        };
      }
      return {
        forward: [],
        signal: {
          type: "complete",
          markdown,
          successLines: [silentAgentLine(), line],
          fallbackLines,
        },
      };
    }

    if (eventType === "turn.failed") {
      this.terminal = true;
      const fallbackLines = [...this.pendingFinalLines, line];
      this.clearPendingFinal();
      return {
        forward: [],
        signal: {
          type: "failed",
          message: "本次处理未能完成，请稍后重试。",
          successLines: [silentAgentLine(), syntheticTurnCompleted()],
          fallbackLines,
        },
      };
    }

    // Thread IDs, turn start, usage and other non-content lifecycle metadata
    // remain byte-for-byte compatible with the native Codex adapter.
    return { forward: [line] };
  }
}
