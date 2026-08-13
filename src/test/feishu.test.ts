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
};

test("Feishu client resolves the placeholder message and converts it to CardKit", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 }),
    jsonResponse({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_123",
            msg_type: "interactive",
            body: { content: "card with ccfp-marker" },
          },
        ],
      },
    }),
    jsonResponse({ code: 0, data: { card_id: "card_123" } }),
    jsonResponse({ code: 0, data: {} }),
  ];
  const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return responses.shift() ?? jsonResponse({ code: 1 }, 500);
  };
  const client = new FeishuClient(config, fetchMock as typeof fetch);
  assert.equal(
    await client.findPlaceholderMessage(
      "oc_chat",
      "ccfp-marker",
      { messageIds: new Set() },
      1,
    ),
    "om_123",
  );
  assert.equal(await client.convertMessageToCard("om_123"), "card_123");
  await client.updateCard("card_123", workingCard("working"), 1);

  assert.match(calls[1]?.url ?? "", /container_id=oc_chat/);
  assert.match(calls[2]?.url ?? "", /cardkit\/v1\/cards\/id_convert/);
  assert.match(calls[3]?.url ?? "", /cardkit\/v1\/cards\/card_123$/);
  assert.doesNotMatch(JSON.stringify(calls.slice(1)), /secret/);
});

test("Feishu client resolves a redacted Card 2.0 placeholder from a before-send snapshot", async () => {
  const responses = [
    jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 }),
    jsonResponse({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_trigger",
            msg_type: "text",
            sender: { id: "ou_user", sender_type: "user" },
            body: { content: JSON.stringify({ text: "question" }) },
          },
        ],
      },
    }),
    jsonResponse({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_placeholder",
            msg_type: "interactive",
            parent_id: "om_trigger",
            sender: { id: "ou_bot", sender_type: "app" },
            body: {
              content: JSON.stringify({
                title: null,
                elements: [[{ tag: "text", text: "请升级至最新版本客户端，以查看内容" }]],
              }),
            },
          },
          {
            message_id: "om_trigger",
            msg_type: "text",
            sender: { id: "ou_user", sender_type: "user" },
            body: { content: JSON.stringify({ text: "question" }) },
          },
        ],
      },
    }),
  ];
  const fetchMock = async () => responses.shift() ?? jsonResponse({ code: 1 }, 500);
  const client = new FeishuClient(config, fetchMock as typeof fetch);

  const snapshot = await client.captureMessageSnapshot("oc_chat", "ou_user");
  assert.equal(
    await client.findPlaceholderMessage("oc_chat", "ccfp-marker", snapshot, 1),
    "om_placeholder",
  );
});

test("CardKit conversion permission failure falls back without throwing", async () => {
  const responses = [
    jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 }),
    jsonResponse({ code: 99991672, msg: "permission denied" }),
  ];
  const fetchMock = async () => responses.shift() ?? jsonResponse({ code: 1 }, 500);
  const client = new FeishuClient(config, fetchMock as typeof fetch);
  assert.equal(await client.convertMessageToCard("om_123"), undefined);
});

test("chat-history snapshot succeeds without sending a message", async () => {
  const calls: string[] = [];
  const responses = [
    jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 }),
    jsonResponse({ code: 0, data: { items: [] } }),
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

test("read-only history permission check returns the visible item count", async () => {
  const responses = [
    jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 }),
    jsonResponse({ code: 0, data: { items: [{ message_id: "om_1" }] } }),
  ];
  const fetchMock = async () => responses.shift() ?? jsonResponse({ code: 1 }, 500);
  const client = new FeishuClient(config, fetchMock as typeof fetch);
  assert.equal(await client.checkChatHistoryAccess("oc_chat"), 1);
});
