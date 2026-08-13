import { randomUUID } from "node:crypto";
import {
  completedCard,
  estimatedAnimationMs,
  failedCard,
  partialCard,
  progressiveFrames,
  streamingCard,
  workingCard,
} from "./card.js";
import { sendMarkdownThroughCCConnect } from "./cc-api.js";
import { loadProjectConfig } from "./config.js";
import { FeishuClient, type ChatMessageSnapshot } from "./feishu.js";
import { transformLocalReferences } from "./references.js";
import { TurnStateStore } from "./state.js";
import type {
  ActivityPhase,
  ActivityProgress,
  ProjectRuntimeConfig,
  TurnState,
} from "./types.js";

const ACTIVE_RETRY_WINDOW_MS = 3_000;
const MAX_FINAL_MARKDOWN_CHARS = 24_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface RuntimeContext {
  project: string;
  sessionKey: string;
  chatId: string;
  userId?: string;
  rootMessageId?: string;
  replyInThread: boolean;
}

export interface BeginResult {
  active: boolean;
  turnId?: string;
  transport?: "cardkit" | "message_patch";
  instruction: string;
}

export interface TurnServiceDependencies {
  env?: NodeJS.ProcessEnv;
  store?: TurnStateStore;
  loadProject?: (name: string) => Promise<ProjectRuntimeConfig>;
  sendMarkdown?: typeof sendMarkdownThroughCCConnect;
  createClient?: (config: ProjectRuntimeConfig) => FeishuClient;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function runtimeContext(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeContext | undefined {
  const project = env.CC_PROJECT?.trim();
  const sessionKey = env.CC_SESSION_KEY?.trim();
  if (!project || !sessionKey) return undefined;
  const parts = sessionKey.split(":");
  if ((parts[0] !== "feishu" && parts[0] !== "lark") || !parts[1]) {
    return undefined;
  }
  return {
    project,
    sessionKey,
    chatId: parts[1],
    ...(parts[2] && parts[2] !== "root" ? { userId: parts[2] } : {}),
    ...(parts[2] === "root" && parts[3] ? { rootMessageId: parts[3] } : {}),
    replyInThread: parts[2] === "root" && Boolean(parts[3]),
  };
}

function markerFor(turnId: string): string {
  return `ccfp-${turnId}`;
}

function placeholderMarkdown(marker: string): string {
  return `**⏳ 正在思考…**\n\n🔒 推理与工具详情不会展示，也无法展开。\n\n[⁣](https://cc-connect-feishu-plus.invalid/turn/${marker})`;
}

function monotonicProgress(
  previous: ActivityProgress | undefined,
  next: ActivityProgress,
): ActivityProgress {
  return {
    reasoningCount: Math.max(previous?.reasoningCount ?? 0, next.reasoningCount),
    toolCount: Math.max(previous?.toolCount ?? 0, next.toolCount),
  };
}

export class TurnService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly store: TurnStateStore;
  private readonly loadProject: (name: string) => Promise<ProjectRuntimeConfig>;
  private readonly sendMarkdown: typeof sendMarkdownThroughCCConnect;
  private readonly createClient: (config: ProjectRuntimeConfig) => FeishuClient;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dependencies: TurnServiceDependencies = {}) {
    this.env = dependencies.env ?? process.env;
    this.store = dependencies.store ?? new TurnStateStore();
    this.loadProject = dependencies.loadProject ?? ((name) => loadProjectConfig(name));
    this.sendMarkdown = dependencies.sendMarkdown ?? sendMarkdownThroughCCConnect;
    if (dependencies.createClient) {
      this.createClient = dependencies.createClient;
    } else {
      const clients = new Map<string, FeishuClient>();
      this.createClient = (project) => {
        const key = `${project.name}:${project.feishu.type}:${project.feishu.appId}`;
        const current = clients.get(key);
        if (current) return current;
        const client = new FeishuClient(project.feishu);
        clients.set(key, client);
        return client;
      };
    }
    this.sleep = dependencies.sleep ?? delay;
  }

  private async locked<T>(sessionKey: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(sessionKey, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(sessionKey) === tail) this.locks.delete(sessionKey);
    }
  }

  async begin(): Promise<BeginResult> {
    const context = runtimeContext(this.env);
    if (!context) {
      return {
        active: false,
        instruction: "This is not a Feishu/Lark CC Connect turn. Reply normally.",
      };
    }

    return this.locked(context.sessionKey, async () => {
      const existing = await this.store.load(context.sessionKey);
      if (
        existing &&
        Date.now() - Date.parse(existing.startedAt) <= ACTIVE_RETRY_WINDOW_MS
      ) {
        return {
          active: true,
          turnId: existing.turnId,
          transport: existing.transport,
          instruction: "The automatic Feishu card for this turn is already active.",
        };
      }

      const project = await this.loadProject(context.project);
      const client = this.createClient(project);
      let snapshot: ChatMessageSnapshot;
      try {
        snapshot = await client.captureMessageSnapshot(
          context.chatId,
          context.userId,
          context.rootMessageId,
        );
      } catch (error) {
        return {
          active: false,
          instruction: `Feishu Plus could not capture safe message context (${safeError(error)}). Reply normally through native CC Connect; no placeholder was sent.`,
        };
      }
      if (existing) {
        try {
          await this.update(client, existing, failedCard("上一次处理意外中断，已开始新的回答。"));
        } catch {
          // A stale card must never prevent the native CC Connect fallback.
        }
        await this.store.remove(context.sessionKey);
      }

      const turnId = randomUUID();
      const marker = markerFor(turnId);
      const initialCard = workingCard("analyzing");
      let state: TurnState | undefined;

      if (!project.feishu.replyToTrigger) {
        try {
          const routingMessageId = context.replyInThread
            ? context.rootMessageId
            : undefined;
          const cardId = await client.createCardEntity(initialCard);
          const messageId = await client.sendCardEntity(
            context.chatId,
            cardId,
            routingMessageId,
            context.replyInThread,
          );
          state = {
            version: 1,
            turnId,
            project: context.project,
            sessionKey: context.sessionKey,
            chatId: context.chatId,
            marker,
            messageId,
            cardId,
            transport: "cardkit",
            sequence: 0,
            phase: "analyzing",
            startedAt: new Date().toISOString(),
          };
        } catch {
          // Fall through to the populated native-message path below.
        }
      }

      if (!state) {
        try {
          await this.sendMarkdown({
            project: context.project,
            sessionKey: context.sessionKey,
            markdown: placeholderMarkdown(marker),
          });
          const messageId = await client.findPlaceholderMessage(
            context.chatId,
            marker,
            snapshot,
          );
          state = {
            version: 1,
            turnId,
            project: context.project,
            sessionKey: context.sessionKey,
            chatId: context.chatId,
            marker,
            messageId,
            transport: "message_patch",
            sequence: 0,
            phase: "analyzing",
            startedAt: new Date().toISOString(),
          };
          await client.patchMessage(messageId, initialCard);
        } catch (error) {
          return {
            active: false,
            instruction: `Feishu Plus could not establish the turn card (${safeError(error)}). Reply normally through native CC Connect.`,
          };
        }
      }

      await this.store.save(state);
      return {
        active: true,
        turnId,
        transport: state.transport,
        instruction: "The automatic Feishu card for this turn is active.",
      };
    });
  }

  async activity(
    phase: ActivityPhase,
    progress?: ActivityProgress,
  ): Promise<void> {
    const context = this.requireContext();
    await this.locked(context.sessionKey, async () => {
      const { state, client } = await this.requireTurn(context);
      if (state.draftMarkdown) {
        throw new Error("turn_activity cannot replace answer text after turn_write has started");
      }
      state.phase = phase;
      const visibleProgress = progress
        ? monotonicProgress(state.progress, progress)
        : undefined;
      if (visibleProgress) state.progress = visibleProgress;
      else delete state.progress;
      await this.update(client, state, workingCard(phase, visibleProgress));
      await this.store.save(state);
    });
  }

  async write(markdownDelta: string): Promise<{ totalCharacters: number }> {
    const delta = markdownDelta;
    if (!delta.trim()) throw new Error("Markdown delta must not be empty");
    const context = this.requireContext();
    return this.locked(context.sessionKey, async () => {
      const { state, client } = await this.requireTurn(context);
      const current = state.draftMarkdown ?? "";
      const next = `${current}${delta}`;
      if ([...next].length > MAX_FINAL_MARKDOWN_CHARS) {
        throw new Error(`answer draft exceeds ${MAX_FINAL_MARKDOWN_CHARS} characters`);
      }

      if (state.transport === "cardkit" && state.cardId) {
        try {
          await this.update(
            client,
            state,
            streamingCard(next, current || " "),
          );
          state.sequence += 1;
          await client.updateTextElement(state.cardId, next, state.sequence);
          state.streamingStarted = true;
        } catch {
          state.transport = "message_patch";
          delete state.cardId;
          state.sequence = 0;
          state.streamingStarted = false;
          await client.patchMessage(state.messageId, partialCard(next));
        }
      } else {
        await client.patchMessage(state.messageId, partialCard(next));
      }
      state.draftMarkdown = next;
      await this.store.save(state);
      return { totalCharacters: [...next].length };
    });
  }

  async complete(markdown: string): Promise<void> {
    const rawContent = markdown.trim();
    if (!rawContent) throw new Error("final Markdown answer must not be empty");
    const context = this.requireContext();
    await this.locked(context.sessionKey, async () => {
      const { state, client, project } = await this.requireTurn(context);
      const content = transformLocalReferences(
        rawContent,
        project.references,
        project.agentType,
        project.feishu.type,
        process.cwd(),
      );
      if ([...content].length > MAX_FINAL_MARKDOWN_CHARS) {
        throw new Error(`final Markdown answer exceeds ${MAX_FINAL_MARKDOWN_CHARS} characters`);
      }
      const draft = state.draftMarkdown ?? "";
      if (state.transport === "cardkit" && state.cardId) {
        try {
          if (!draft || !content.startsWith(draft)) {
            await this.update(client, state, streamingCard(content));
            state.sequence += 1;
            await client.updateTextElement(state.cardId, content, state.sequence);
            await this.store.save(state);
            await this.sleep(estimatedAnimationMs(content));
          } else if (content !== draft) {
            await this.update(client, state, streamingCard(content, draft));
            state.sequence += 1;
            await client.updateTextElement(state.cardId, content, state.sequence);
            await this.store.save(state);
            await this.sleep(estimatedAnimationMs(content.slice(draft.length)));
          }
          await this.update(client, state, completedCard(content));
        } catch {
          state.transport = "message_patch";
          delete state.cardId;
          state.sequence = 0;
          if (draft) await client.patchMessage(state.messageId, completedCard(content));
          else await this.patchProgressively(client, state, content);
        }
      } else {
        if (draft) await client.patchMessage(state.messageId, completedCard(content));
        else await this.patchProgressively(client, state, content);
      }
      await this.store.remove(context.sessionKey);
    });
  }

  async fail(message: string): Promise<void> {
    const context = this.requireContext();
    await this.locked(context.sessionKey, async () => {
      const { state, client } = await this.requireTurn(context);
      await this.update(client, state, failedCard(message.slice(0, 500)));
      await this.store.remove(context.sessionKey);
    });
  }

  private requireContext(): RuntimeContext {
    const context = runtimeContext(this.env);
    if (!context) throw new Error("not running inside a Feishu/Lark CC Connect turn");
    return context;
  }

  private async requireTurn(context: RuntimeContext): Promise<{
    state: TurnState;
    client: FeishuClient;
    project: ProjectRuntimeConfig;
  }> {
    const state = await this.store.load(context.sessionKey);
    if (!state) throw new Error("the automatic Feishu card is not active");
    const project = await this.loadProject(context.project);
    return { state, client: this.createClient(project), project };
  }

  private async update(
    client: FeishuClient,
    state: TurnState,
    card: ReturnType<typeof workingCard>,
  ): Promise<void> {
    if (state.transport === "cardkit" && state.cardId) {
      const sequence = state.sequence + 1;
      await client.updateCard(state.cardId, card, sequence);
      state.sequence = sequence;
      return;
    }
    await client.patchMessage(state.messageId, card);
  }

  private async patchProgressively(
    client: FeishuClient,
    state: TurnState,
    markdown: string,
  ): Promise<void> {
    const frames = progressiveFrames(markdown);
    for (const frame of frames.slice(0, -1)) {
      await client.patchMessage(state.messageId, partialCard(frame));
      await this.sleep(90);
    }
    await client.patchMessage(state.messageId, completedCard(markdown));
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown error";
}
