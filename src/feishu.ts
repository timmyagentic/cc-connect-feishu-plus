import type { CardDocument } from "./card.js";
import type { FeishuPlatformConfig } from "./types.js";

type Fetch = typeof globalThis.fetch;
const REQUEST_TIMEOUT_MS = 5_000;

interface FeishuEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

interface MessageItem {
  message_id?: string;
  msg_type?: string;
  parent_id?: string;
  root_id?: string;
  sender?: {
    id?: string;
    sender_type?: string;
  };
  body?: { content?: string };
}

interface MessageResponseData {
  message_id?: string;
}

export interface ChatMessageSnapshot {
  messageIds: ReadonlySet<string>;
  triggerMessageId?: string;
}

interface TokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FeishuApiError extends Error {
  readonly code?: number;
  readonly status?: number;

  constructor(message: string, options: { code?: number; status?: number } = {}) {
    super(message);
    this.name = "FeishuApiError";
    if (options.code !== undefined) this.code = options.code;
    if (options.status !== undefined) this.status = options.status;
  }
}

export class FeishuClient {
  private token?: { value: string; expiresAt: number };

  constructor(
    readonly config: FeishuPlatformConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {}

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async tenantToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }
    const response = await this.fetchImpl(
      this.url("/open-apis/auth/v3/tenant_access_token/internal"),
      {
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      },
    );
    const body = (await response.json()) as TokenResponse;
    if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
      throw new FeishuApiError(
        `Feishu tenant token request failed${body.msg ? `: ${body.msg}` : ""}`,
        { code: body.code, status: response.status },
      );
    }
    this.token = {
      value: body.tenant_access_token,
      expiresAt: Date.now() + Math.max(60, body.expire ?? 7_200) * 1_000,
    };
    return this.token.value;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const token = await this.tenantToken();
    const response = await this.fetchImpl(this.url(path), {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
        ...init.headers,
      },
    });
    const body = (await response.json()) as FeishuEnvelope<T>;
    if (!response.ok || body.code !== 0) {
      throw new FeishuApiError(
        `Feishu API request failed${body.msg ? `: ${body.msg}` : ""}`,
        { code: body.code, status: response.status },
      );
    }
    return body.data as T;
  }

  private async recentMessages(chatId: string, pageSize: number): Promise<MessageItem[]> {
    const query = new URLSearchParams({
      container_id_type: "chat",
      container_id: chatId,
      sort_type: "ByCreateTimeDesc",
      page_size: String(pageSize),
    });
    const data = await this.request<{ items?: MessageItem[] }>(
      `/open-apis/im/v1/messages?${query.toString()}`,
      { method: "GET" },
    );
    return data.items ?? [];
  }

  async checkChatHistoryAccess(chatId: string): Promise<number> {
    return (await this.recentMessages(chatId, 1)).length;
  }

  async captureMessageSnapshot(
    chatId: string,
    userId?: string,
    rootMessageId?: string,
  ): Promise<ChatMessageSnapshot> {
    const items = await this.recentMessages(chatId, 50);
    const trigger = items.find(
      (item) =>
        item.sender?.sender_type === "user" &&
        (!rootMessageId ||
          item.message_id === rootMessageId ||
          item.root_id === rootMessageId) &&
        (!userId || item.sender.id === userId),
    );
    return {
      messageIds: new Set(
        items.flatMap((item) => (item.message_id ? [item.message_id] : [])),
      ),
      ...(trigger?.message_id ? { triggerMessageId: trigger.message_id } : {}),
    };
  }

  async findPlaceholderMessage(
    chatId: string,
    marker: string,
    snapshot: ChatMessageSnapshot,
    attempts = 10,
  ): Promise<string> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const items = await this.recentMessages(chatId, 50);
      const markerMatch = items.find(
        (item) =>
          item.msg_type === "interactive" &&
          typeof item.body?.content === "string" &&
          item.body.content.includes(marker),
      );
      if (markerMatch?.message_id) return markerMatch.message_id;

      const candidates = items.filter(
        (item) =>
          item.msg_type === "interactive" &&
          typeof item.message_id === "string" &&
          !snapshot.messageIds.has(item.message_id) &&
          (item.sender?.sender_type === undefined ||
            item.sender.sender_type === "app"),
      );
      const replyMatch = snapshot.triggerMessageId
        ? candidates.find((item) => item.parent_id === snapshot.triggerMessageId)
        : undefined;
      const match =
        replyMatch ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (match?.message_id) return match.message_id;
      if (attempt + 1 < attempts) await delay(250);
    }
    throw new Error("could not resolve the placeholder Feishu message id");
  }

  async createCardEntity(card: CardDocument): Promise<string> {
    const data = await this.request<{ card_id?: string }>(
      "/open-apis/cardkit/v1/cards",
      {
        method: "POST",
        body: JSON.stringify({ type: "card_json", data: JSON.stringify(card) }),
      },
    );
    if (!data.card_id) {
      throw new FeishuApiError("Feishu create card entity returned no card_id");
    }
    return data.card_id;
  }

  async sendCardEntity(
    chatId: string,
    cardId: string,
    triggerMessageId?: string,
    replyInThread = false,
  ): Promise<string> {
    const content = JSON.stringify({
      type: "card",
      data: { card_id: cardId },
    });
    const data = triggerMessageId
      ? await this.request<MessageResponseData>(
          `/open-apis/im/v1/messages/${encodeURIComponent(triggerMessageId)}/reply`,
          {
            method: "POST",
            body: JSON.stringify({
              msg_type: "interactive",
              content,
              ...(replyInThread ? { reply_in_thread: true } : {}),
            }),
          },
        )
      : await this.request<MessageResponseData>(
          "/open-apis/im/v1/messages?receive_id_type=chat_id",
          {
            method: "POST",
            body: JSON.stringify({
              receive_id: chatId,
              msg_type: "interactive",
              content,
            }),
          },
        );
    if (!data.message_id) {
      throw new FeishuApiError("Feishu send card entity returned no message_id");
    }
    return data.message_id;
  }

  async patchMessage(messageId: string, card: CardDocument): Promise<void> {
    await this.request<Record<string, never>>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      { method: "PATCH", body: JSON.stringify({ content: JSON.stringify(card) }) },
    );
  }

  async updateCard(cardId: string, card: CardDocument, sequence: number): Promise<void> {
    await this.request<Record<string, never>>(
      `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          card: { type: "card_json", data: JSON.stringify(card) },
          sequence,
        }),
      },
    );
  }

  async updateTextElement(
    cardId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    await this.request<Record<string, never>>(
      `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/main_text/content`,
      { method: "PUT", body: JSON.stringify({ content, sequence }) },
    );
  }
}
