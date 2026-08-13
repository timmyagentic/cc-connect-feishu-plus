import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CardDocument } from "../card.js";
import type { FeishuClient } from "../feishu.js";
import { TurnStateStore } from "../state.js";
import { runtimeContext, TurnService } from "../turn-service.js";
import type { ProjectRuntimeConfig } from "../types.js";

class FakeClient {
  readonly cardUpdates: Array<{ cardId: string; card: CardDocument; sequence: number }> = [];
  readonly patches: Array<{ messageId: string; card: CardDocument }> = [];
  readonly textUpdates: Array<{ cardId: string; content: string; sequence: number }> = [];
  readonly initializations: Array<
    | { kind: "create"; card: CardDocument }
    | {
        kind: "send";
        chatId: string;
        cardId: string;
        triggerMessageId?: string;
        replyInThread: boolean;
      }
  > = [];
  conversions = 0;

  constructor(
    private readonly cardId: string | undefined,
    private readonly triggerMessageId: string | null = "om_trigger",
  ) {}

  async captureMessageSnapshot(): Promise<{
    messageIds: ReadonlySet<string>;
    triggerMessageId?: string;
  }> {
    return {
      messageIds: new Set(this.triggerMessageId ? [this.triggerMessageId] : []),
      ...(this.triggerMessageId ? { triggerMessageId: this.triggerMessageId } : {}),
    };
  }

  async findPlaceholderMessage(
    _chatId: string,
    marker: string,
    snapshot: { messageIds: ReadonlySet<string>; triggerMessageId?: string },
  ): Promise<string> {
    assert.match(marker, /^ccfp-/);
    assert.equal(snapshot.triggerMessageId, this.triggerMessageId ?? undefined);
    return "om_message";
  }

  async createCardEntity(card: CardDocument): Promise<string> {
    this.initializations.push({ kind: "create", card });
    if (!this.cardId) throw new Error("CardKit unavailable");
    return this.cardId;
  }

  async sendCardEntity(
    chatId: string,
    cardId: string,
    triggerMessageId?: string,
    replyInThread = false,
  ): Promise<string> {
    this.initializations.push({
      kind: "send",
      chatId,
      cardId,
      ...(triggerMessageId ? { triggerMessageId } : {}),
      replyInThread,
    });
    return "om_message";
  }

  async convertMessageToCard(): Promise<string | undefined> {
    this.conversions += 1;
    return this.cardId;
  }

  async updateCard(cardId: string, card: CardDocument, sequence: number): Promise<void> {
    this.cardUpdates.push({ cardId, card, sequence });
  }

  async patchMessage(messageId: string, card: CardDocument): Promise<void> {
    this.patches.push({ messageId, card });
  }

  async updateTextElement(cardId: string, content: string, sequence: number): Promise<void> {
    this.textUpdates.push({ cardId, content, sequence });
  }
}

const project: ProjectRuntimeConfig = {
  name: "demo",
  agentType: "codex",
  agentCommand: "codex",
  backend: "exec",
  feishu: {
    type: "feishu",
    appId: "cli_test",
    appSecret: "secret",
    baseUrl: "https://open.feishu.cn",
    replyToTrigger: true,
  },
};

test("runtimeContext activates only inherited Feishu/Lark CC sessions", () => {
  assert.deepEqual(
    runtimeContext({ CC_PROJECT: "demo", CC_SESSION_KEY: "feishu:oc_chat:ou_user" }),
    {
      project: "demo",
      sessionKey: "feishu:oc_chat:ou_user",
      chatId: "oc_chat",
      userId: "ou_user",
      replyInThread: false,
    },
  );
  assert.deepEqual(
    runtimeContext({
      CC_PROJECT: "demo",
      CC_SESSION_KEY: "feishu:oc_chat:root:om_root",
    }),
    {
      project: "demo",
      sessionKey: "feishu:oc_chat:root:om_root",
      chatId: "oc_chat",
      rootMessageId: "om_root",
      replyInThread: true,
    },
  );
  assert.equal(
    runtimeContext({ CC_PROJECT: "demo", CC_SESSION_KEY: "telegram:123:456" }),
    undefined,
  );
});

test("CardKit lifecycle keeps one quoted message and ends in Done", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccfp-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new FakeClient("card_123");
  const sent: string[] = [];
  const service = new TurnService({
    env: { CC_PROJECT: "demo", CC_SESSION_KEY: "feishu:oc_chat:ou_user" },
    store: new TurnStateStore(directory),
    loadProject: async () => project,
    sendMarkdown: async ({ markdown }) => {
      sent.push(markdown);
    },
    createClient: () => client as unknown as FeishuClient,
    sleep: async () => undefined,
  });

  const begin = await service.begin();
  assert.equal(begin.active, true);
  assert.equal(begin.transport, "cardkit");
  assert.equal(sent.length, 0, "CardKit should be populated before it is sent");
  assert.equal(client.conversions, 0, "id_convert must not create a visible blank window");
  assert.deepEqual(
    client.initializations.map((entry) => entry.kind),
    ["create", "send"],
  );
  assert.match(JSON.stringify(client.initializations[0]), /正在思考/);
  assert.match(JSON.stringify(client.initializations[0]), /无法展开/);
  assert.deepEqual(client.initializations[1], {
    kind: "send",
    chatId: "oc_chat",
    cardId: "card_123",
    triggerMessageId: "om_trigger",
    replyInThread: false,
  });

  await service.activity("verifying");
  await service.complete("这是最终答案。\n\n```ts\nconst ok = true;\n```");
  assert.equal(client.patches.length, 0);
  assert.equal(client.textUpdates.length, 1);
  assert.match(client.textUpdates[0]?.content ?? "", /最终答案/);
  assert.equal(client.cardUpdates.at(-1)?.card.header.title.content, "✅ Done");
  assert.deepEqual(
    client.cardUpdates.map((update) => update.sequence),
    [1, 2, 4],
  );
});

test("reply_to_trigger=false sends the populated card without a quote", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccfp-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new FakeClient("card_123");
  const service = new TurnService({
    env: { CC_PROJECT: "demo", CC_SESSION_KEY: "feishu:oc_chat:ou_user" },
    store: new TurnStateStore(directory),
    loadProject: async () => ({
      ...project,
      feishu: { ...project.feishu, replyToTrigger: false },
    }),
    sendMarkdown: async () => undefined,
    createClient: () => client as unknown as FeishuClient,
    sleep: async () => undefined,
  });

  assert.equal((await service.begin()).transport, "cardkit");
  assert.deepEqual(client.initializations[1], {
    kind: "send",
    chatId: "oc_chat",
    cardId: "card_123",
    replyInThread: false,
  });
});

test("missing trigger falls back to native quoted delivery before creating CardKit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccfp-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new FakeClient("card_123", null);
  const sent: string[] = [];
  const service = new TurnService({
    env: { CC_PROJECT: "demo", CC_SESSION_KEY: "feishu:oc_chat:ou_user" },
    store: new TurnStateStore(directory),
    loadProject: async () => project,
    sendMarkdown: async ({ markdown }) => {
      sent.push(markdown);
    },
    createClient: () => client as unknown as FeishuClient,
    sleep: async () => undefined,
  });

  assert.equal((await service.begin()).transport, "message_patch");
  assert.equal(client.initializations.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /正在思考/);
});

test("message PATCH fallback provides progressive updates on the same message", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccfp-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new FakeClient(undefined);
  const service = new TurnService({
    env: { CC_PROJECT: "demo", CC_SESSION_KEY: "feishu:oc_chat:ou_user" },
    store: new TurnStateStore(directory),
    loadProject: async () => project,
    sendMarkdown: async () => undefined,
    createClient: () => client as unknown as FeishuClient,
    sleep: async () => undefined,
  });
  const begin = await service.begin();
  assert.equal(begin.transport, "message_patch");
  assert.equal(client.conversions, 0, "fallback must not use id_convert");
  await service.complete("逐步显示这条稍微长一点的回答");
  assert.ok(client.patches.length > 2);
  assert.ok(client.patches.every((patch) => patch.messageId === "om_message"));
  assert.equal(client.patches.at(-1)?.card.header.title.content, "✅ Done");
});

test("turn_write appends final-quality chunks through CardKit before completion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccfp-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new FakeClient("card_123");
  const service = new TurnService({
    env: { CC_PROJECT: "demo", CC_SESSION_KEY: "feishu:oc_chat:ou_user" },
    store: new TurnStateStore(directory),
    loadProject: async () => project,
    sendMarkdown: async () => undefined,
    createClient: () => client as unknown as FeishuClient,
    sleep: async () => undefined,
  });
  await service.begin();
  assert.deepEqual(await service.write("第一段。\n\n"), { totalCharacters: 6 });
  assert.deepEqual(await service.write("第二段。"), { totalCharacters: 10 });
  assert.equal(client.textUpdates[0]?.content, "第一段。\n\n");
  assert.equal(client.textUpdates[1]?.content, "第一段。\n\n第二段。");
  await service.complete("第一段。\n\n第二段。");
  assert.equal(client.cardUpdates.at(-1)?.card.header.title.content, "✅ Done");
  assert.equal(client.textUpdates.length, 2);
});

test("turn_activity cannot erase an answer draft", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccfp-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new FakeClient(undefined);
  const service = new TurnService({
    env: { CC_PROJECT: "demo", CC_SESSION_KEY: "feishu:oc_chat:ou_user" },
    store: new TurnStateStore(directory),
    loadProject: async () => project,
    sendMarkdown: async () => undefined,
    createClient: () => client as unknown as FeishuClient,
    sleep: async () => undefined,
  });
  await service.begin();
  await service.write("可见正文");
  await assert.rejects(service.activity("working"), /cannot replace answer text/);
});

test("turn_activity renders anonymous progress and preparing answer removes it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccfp-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new FakeClient("card_123");
  const service = new TurnService({
    env: { CC_PROJECT: "demo", CC_SESSION_KEY: "feishu:oc_chat:ou_user" },
    store: new TurnStateStore(directory),
    loadProject: async () => project,
    sendMarkdown: async () => undefined,
    createClient: () => client as unknown as FeishuClient,
    sleep: async () => undefined,
  });

  await service.begin();
  await service.activity("working", { reasoningCount: 2, toolCount: 7 });
  const progressCard = JSON.stringify(client.cardUpdates.at(-1)?.card);
  assert.match(progressCard, /正在调用工具/);
  assert.match(progressCard, /推理 2 次/);
  assert.match(progressCard, /工具 7 次/);
  assert.doesNotMatch(progressCard, /collapsible_panel|expanded/);

  await service.activity("working", { reasoningCount: 1, toolCount: 3 });
  const nonRegressingCard = JSON.stringify(client.cardUpdates.at(-1)?.card);
  assert.match(nonRegressingCard, /推理 2 次/);
  assert.match(nonRegressingCard, /工具 7 次/);

  await service.activity("preparing_answer");
  const preparingCard = JSON.stringify(client.cardUpdates.at(-1)?.card);
  assert.doesNotMatch(preparingCard, /推理 2 次|工具 7 次/);
});

test("final plugin card applies the project's compact file-reference display", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccfp-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new FakeClient("card_123");
  const service = new TurnService({
    env: { CC_PROJECT: "demo", CC_SESSION_KEY: "feishu:oc_chat:ou_user" },
    store: new TurnStateStore(directory),
    loadProject: async () => ({
      ...project,
      references: {
        normalizeAgents: ["codex"],
        renderPlatforms: ["feishu"],
        displayPath: "smart",
        markerStyle: "emoji",
        enclosureStyle: "code",
      },
    }),
    sendMarkdown: async () => undefined,
    createClient: () => client as unknown as FeishuClient,
    sleep: async () => undefined,
  });
  await service.begin();
  await service.complete("See /very/long/private/path/app.ts:42");
  assert.equal(client.textUpdates[0]?.content, "See 📄 `app.ts:42`");
});

test("non-Feishu turn remains native and sends nothing", async () => {
  let sent = false;
  const service = new TurnService({
    env: { CC_PROJECT: "demo", CC_SESSION_KEY: "telegram:123:456" },
    sendMarkdown: async () => {
      sent = true;
    },
  });
  assert.equal((await service.begin()).active, false);
  assert.equal(sent, false);
});
