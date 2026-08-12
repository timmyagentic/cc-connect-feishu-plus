import type { CardDocument } from "./card.js";
import type { FeishuPlatformConfig } from "./types.js";

type Fetch = typeof globalThis.fetch;

interface FeishuEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

interface MessageItem {
  message_id?: string;
  msg_type?: string;
  body?: { content?: string };
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

  async findMessageByMarker(
    chatId: string,
    marker: string,
    attempts = 10,
  ): Promise<string> {
    const query = new URLSearchParams({
      container_id_type: "chat",
      container_id: chatId,
      sort_type: "ByCreateTimeDesc",
      page_size: "50",
    });

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const data = await this.request<{ items?: MessageItem[] }>(
        `/open-apis/im/v1/messages?${query.toString()}`,
        { method: "GET" },
      );
      const match = data.items?.find(
        (item) =>
          item.msg_type === "interactive" &&
          typeof item.body?.content === "string" &&
          item.body.content.includes(marker),
      );
      if (match?.message_id) return match.message_id;
      if (attempt + 1 < attempts) await delay(250);
    }
    throw new Error("could not resolve the placeholder Feishu message id");
  }

  async checkChatHistoryAccess(chatId: string): Promise<number> {
    const query = new URLSearchParams({
      container_id_type: "chat",
      container_id: chatId,
      sort_type: "ByCreateTimeDesc",
      page_size: "1",
    });
    const data = await this.request<{ items?: MessageItem[] }>(
      `/open-apis/im/v1/messages?${query.toString()}`,
      { method: "GET" },
    );
    return data.items?.length ?? 0;
  }

  async convertMessageToCard(messageId: string): Promise<string | undefined> {
    try {
      const data = await this.request<{ card_id?: string }>(
        "/open-apis/cardkit/v1/cards/id_convert",
        { method: "POST", body: JSON.stringify({ message_id: messageId }) },
      );
      return data.card_id;
    } catch (error) {
      if (error instanceof FeishuApiError) return undefined;
      throw error;
    }
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
