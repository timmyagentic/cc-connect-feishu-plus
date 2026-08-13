import { createHash } from "node:crypto";
import type { ActivityPhase, ActivityProgress } from "./types.js";

export interface CompleteSignal {
  type: "complete";
  markdown: string;
  successLines: string[];
  fallbackLines: string[];
}

export interface ActivitySignal {
  type: "activity";
  phase: ActivityPhase;
  source: "reasoning" | "tool";
  progress: ActivityProgress;
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

function itemKey(item: Record<string, unknown>): string | undefined {
  if (typeof item.id !== "string" || item.id === "") return undefined;
  return createHash("sha256").update(item.id).digest("base64url");
}

function isToolMilestone(count: number): boolean {
  if (count <= 5) return true;
  if (count <= 20) return count % 5 === 0;
  return count % 10 === 0;
}

/**
 * Allows exact early updates and slow tool updates while coalescing a rapid
 * burst into deterministic milestones. No event content enters this gate.
 */
export class ActivityUpdateGate {
  private lastPublishedAt: number | undefined;

  constructor(
    private readonly minimumIntervalMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  shouldPublish(signal: ActivitySignal): boolean {
    const current = this.now();
    const elapsed =
      this.lastPublishedAt === undefined ||
      current - this.lastPublishedAt >= this.minimumIntervalMs;
    const milestone =
      signal.source === "reasoning" ||
      isToolMilestone(signal.progress.toolCount);
    if (!elapsed && !milestone) return false;
    this.lastPublishedAt = current;
    return true;
  }
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
  private readonly seenReasoningKeys = new Set<string>();
  private readonly seenToolKeys = new Set<string>();
  private readonly identifiedToolsInFlight = new Set<string>();
  private anonymousToolsInFlight = 0;
  private reasoningCount = 0;
  private toolCount = 0;
  private terminal = false;

  get terminalHandled(): boolean {
    return this.terminal;
  }

  private clearPendingFinal(): void {
    this.pendingFinalText = [];
    this.pendingFinalLines = [];
  }

  private activity(
    phase: ActivityPhase,
    source: ActivitySignal["source"],
  ): FilterResult {
    this.clearPendingFinal();
    return {
      forward: [],
      signal: {
        type: "activity",
        phase,
        source,
        progress: {
          reasoningCount: this.reasoningCount,
          toolCount: this.toolCount,
        },
      },
    };
  }

  private reasoningCompleted(item: Record<string, unknown>): FilterResult {
    this.clearPendingFinal();
    const key = itemKey(item);
    if (key && this.seenReasoningKeys.has(key)) return { forward: [] };
    if (key) this.seenReasoningKeys.add(key);
    this.reasoningCount += 1;
    return this.activity("analyzing", "reasoning");
  }

  private toolStarted(item: Record<string, unknown>): FilterResult {
    this.clearPendingFinal();
    const key = itemKey(item);
    if (key) {
      if (this.seenToolKeys.has(key)) return { forward: [] };
      this.seenToolKeys.add(key);
      this.identifiedToolsInFlight.add(key);
    } else {
      this.anonymousToolsInFlight += 1;
    }
    this.toolCount += 1;
    return this.activity("working", "tool");
  }

  private toolCompleted(item: Record<string, unknown>): FilterResult {
    this.clearPendingFinal();
    const key = itemKey(item);
    if (key) {
      if (this.identifiedToolsInFlight.delete(key)) return { forward: [] };
      if (this.seenToolKeys.has(key)) return { forward: [] };
      this.seenToolKeys.add(key);
      if (this.anonymousToolsInFlight > 0) {
        this.anonymousToolsInFlight -= 1;
        return { forward: [] };
      }
    } else if (this.anonymousToolsInFlight > 0) {
      this.anonymousToolsInFlight -= 1;
      return { forward: [] };
    } else if (this.identifiedToolsInFlight.size > 0) {
      const first = this.identifiedToolsInFlight.values().next().value;
      if (first) this.identifiedToolsInFlight.delete(first);
      return { forward: [] };
    }
    this.toolCount += 1;
    return this.activity("working", "tool");
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
      if (!item) return { forward: [] };
      const itemType = item?.type;
      if (itemType === "reasoning") {
        this.clearPendingFinal();
        return { forward: [] };
      }
      if (isMessageItem(itemType) || itemType === "error") {
        return { forward: [] };
      }
      return this.toolStarted(item);
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
      if (itemType === "reasoning") {
        return this.reasoningCompleted(item);
      }
      if (itemType === "error") {
        this.clearPendingFinal();
        return { forward: [] };
      }
      return this.toolCompleted(item);
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
