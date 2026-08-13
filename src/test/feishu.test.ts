import assert from "node:assert/strict";
import test from "node:test";
import { workingCard } from "../card.js";
import { FeishuClient } from "../feishu.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const config = {
  type: "feishu" as const,
  appId: "cli_test",
  appSecret: "secret",
  baseUrl: "https://open.feishu.cn",
  replyToTrigger: true,
};

test("Feishu client creates a populated CardKit entity before using an explicit reply anchor", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 }),
    jsonResponse({ code: 0, data: { card_id: "card_123" } }),
    jsonResponse({ code: 0, data: { message_id: "om_card" } }),
    jsonResponse({ code: 0, data: {} }),
  ];
  const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return responses.shift() ?? jsonResponse({ code: 1 }, 500);
  };
  const client = new FeishuClient(config, fetchMock as typeof fetch);
  const initialCard = workingCard("analyzing");
  assert.equal(await client.createCardEntity(initialCard), "card_123");
  assert.equal(
    await client.sendCardEntity("oc_chat", "card_123", "om_trigger"),
    "om_card",
  );
  await client.updateCard("card_123", workingCard("working"), 1);

  assert.match(calls[1]?.url ?? "", /cardkit\/v1\/cards$/);
  assert.match(String(calls[1]?.init?.body), /正在思考/);
  assert.match(calls[2]?.url ?? "", /im\/v1\/messages\/om_trigger\/reply$/);
  assert.match(String(calls[2]?.init?.body), /card_123/);
  assert.match(calls[3]?.url ?? "", /cardkit\/v1\/cards\/card_123$/);
  assert.doesNotMatch(JSON.stringify(calls.slice(1)), /secret/);
});

test("Feishu client resolves a redacted Card 2.0 placeholder from a before-send snapshot", async () => {
  let historyCalls = 0;
  const fetchMock = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
      return jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 });
    }
    if (url.endsWith("/open-apis/bot/v3/info")) {
      return jsonResponse({ code: 0, bot: { open_id: "ou_bot" } });
    }
    if (url.includes("/open-apis/im/v1/messages?")) {
      historyCalls += 1;
      if (historyCalls === 1) {
        return jsonResponse({
          code: 0,
          data: {
            items: [
              {
                message_id: "om_newer_other_participant",
                msg_type: "text",
                sender: { id: "ou_other", sender_type: "user" },
              },
            ],
          },
        });
      }
      return jsonResponse({
        code: 0,
        data: {
          items: [
            {
              message_id: "om_other_bot_card",
              msg_type: "interactive",
              parent_id: "om_newer_other_participant",
              sender: { id: "ou_other_bot", sender_type: "app" },
              body: { content: "redacted Card 2.0 body" },
            },
            {
              message_id: "om_placeholder",
              msg_type: "interactive",
              parent_id: "om_actual_trigger",
              sender: { id: "ou_bot", sender_type: "app" },
              body: { content: "redacted Card 2.0 body" },
            },
            {
              message_id: "om_newer_other_participant",
              msg_type: "text",
              sender: { id: "ou_other", sender_type: "user" },
            },
          ],
        },
      });
    }
    return jsonResponse({ code: 1 }, 500);
  };
  const client = new FeishuClient(config, fetchMock as typeof fetch);

  const snapshot = await client.captureMessageSnapshot("oc_chat");
  assert.equal(
    await client.findPlaceholderMessage("oc_chat", "ccfp-marker", snapshot, 1),
    "om_placeholder",
  );
});

test("CardKit entity creation reports permission failure to the caller", async () => {
  const responses = [
    jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 }),
    jsonResponse({ code: 99991672, msg: "permission denied" }),
  ];
  const fetchMock = async () => responses.shift() ?? jsonResponse({ code: 1 }, 500);
  const client = new FeishuClient(config, fetchMock as typeof fetch);
  await assert.rejects(client.createCardEntity(workingCard("analyzing")), /permission denied/);
});

test("message snapshot fails closed when the sending bot identity is unavailable", async () => {
  const responses = [
    jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 }),
    jsonResponse({ code: 0, data: { items: [] } }),
    jsonResponse({ code: 1, msg: "bot unavailable" }),
  ];
  const fetchMock = async () => responses.shift() ?? jsonResponse({ code: 1 }, 500);
  const client = new FeishuClient(config, fetchMock as typeof fetch);
  await assert.rejects(
    client.captureMessageSnapshot("oc_chat"),
    /bot identity request failed: bot unavailable/,
  );
});

test("Feishu client sends a standalone card entity when native reply is disabled", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 }),
    jsonResponse({ code: 0, data: { message_id: "om_card" } }),
  ];
  const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return responses.shift() ?? jsonResponse({ code: 1 }, 500);
  };
  const client = new FeishuClient(config, fetchMock as typeof fetch);
  assert.equal(await client.sendCardEntity("oc_chat", "card_123"), "om_card");
  assert.match(calls[1]?.url ?? "", /messages\?receive_id_type=chat_id$/);
  assert.match(String(calls[1]?.init?.body), /oc_chat/);
});

test("Feishu client preserves CC Connect thread-isolation reply semantics", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 }),
    jsonResponse({ code: 0, data: { message_id: "om_card" } }),
  ];
  const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return responses.shift() ?? jsonResponse({ code: 1 }, 500);
  };
  const client = new FeishuClient(config, fetchMock as typeof fetch);
  assert.equal(
    await client.sendCardEntity("oc_chat", "card_123", "om_trigger", true),
    "om_card",
  );
  assert.match(String(calls[1]?.init?.body), /"reply_in_thread":true/);
});

test("chat-history snapshot succeeds without sending a message", async () => {
  const calls: string[] = [];
  const responses = [
    jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 }),
    jsonResponse({ code: 0, data: { items: [] } }),
    jsonResponse({ code: 0, bot: { open_id: "ou_bot" } }),
  ];
  const fetchMock = async (input: string | URL | Request) => {
    calls.push(String(input));
    return responses.shift() ?? jsonResponse({ code: 1 }, 500);
  };
  const client = new FeishuClient(config, fetchMock as typeof fetch);
  assert.equal((await client.captureMessageSnapshot("oc_chat")).messageIds.size, 0);
  assert.match(calls[1] ?? "", /page_size=50/);
  assert.ok(calls.every((url) => !url.includes("\/messages\/")));
});

test("thread snapshot records its root and the authenticated bot identity", async () => {
  const responses = [
    jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 }),
    jsonResponse({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_other",
            root_id: "om_other_root",
            sender: { id: "ou_other", sender_type: "user" },
          },
          {
            message_id: "om_thread_reply",
            root_id: "om_root",
            sender: { id: "ou_user", sender_type: "user" },
          },
          {
            message_id: "om_root",
            sender: { id: "ou_user", sender_type: "user" },
          },
        ],
      },
    }),
    jsonResponse({ code: 0, bot: { open_id: "ou_bot" } }),
  ];
  const fetchMock = async () => responses.shift() ?? jsonResponse({ code: 1 }, 500);
  const client = new FeishuClient(config, fetchMock as typeof fetch);
  const snapshot = await client.captureMessageSnapshot(
    "oc_chat",
    undefined,
    "om_root",
  );
  assert.equal(snapshot.rootMessageId, "om_root");
  assert.equal(snapshot.botOpenId, "ou_bot");
});

test("read-only history permission check returns the visible item count", async () => {
  const responses = [
    jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 }),
    jsonResponse({ code: 0, data: { items: [{ message_id: "om_1" }] } }),
  ];
  const fetchMock = async () => responses.shift() ?? jsonResponse({ code: 1 }, 500);
  const client = new FeishuClient(config, fetchMock as typeof fetch);
  assert.equal(await client.checkChatHistoryAccess("oc_chat"), 1);
});
