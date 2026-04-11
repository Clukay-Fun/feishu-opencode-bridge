import type { FeishuPostPayload } from "./formatter.js";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

export class FeishuApiClient {
  private cachedToken: { token: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(private readonly appId: string, private readonly appSecret: string) {}

  async sendMessage(chatId: string, payload: FeishuPostPayload): Promise<{ messageId: string }> {
    const token = await this.getTenantToken();
    const response = await withRetry(() => fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ receive_id: chatId, ...payload }),
    }));
    const body = (await response.json()) as { code: number; msg?: string; data?: { message_id?: string } };
    if (!response.ok || body.code !== 0 || !body.data?.message_id) {
      throw new Error(`Feishu sendMessage failed: ${body.msg ?? response.statusText}`);
    }
    return { messageId: body.data.message_id };
  }

  async replyMessage(messageId: string, payload: FeishuPostPayload): Promise<{ messageId: string }> {
    const token = await this.getTenantToken();
    const response = await withRetry(() => fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }));
    const body = (await response.json()) as { code: number; msg?: string; data?: { message_id?: string } };
    if (!response.ok || body.code !== 0 || !body.data?.message_id) {
      throw new Error(`Feishu replyMessage failed: ${body.msg ?? response.statusText}`);
    }
    return { messageId: body.data.message_id };
  }

  async updateMessage(messageId: string, payload: FeishuPostPayload): Promise<{ messageId: string }> {
    const token = await this.getTenantToken();
    const response = await withRetry(() => fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }));
    const body = (await response.json()) as { code: number; msg?: string; data?: { message_id?: string } };
    if (!response.ok || body.code !== 0) {
      throw new Error(`Feishu updateMessage failed: ${body.msg ?? response.statusText}`);
    }
    return { messageId: body.data?.message_id ?? messageId };
  }

  async getTenantToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.token;
    }

    if (this.tokenRequest) {
      return this.tokenRequest;
    }

    this.tokenRequest = this.fetchTenantToken().finally(() => {
      this.tokenRequest = null;
    });
    return this.tokenRequest;
  }

  private async fetchTenantToken(): Promise<string> {
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const body = (await response.json()) as { code: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`Feishu fetch token failed: ${body.msg ?? response.statusText}`);
    }

    const expireSeconds = typeof body.expire === "number" && Number.isFinite(body.expire) ? body.expire : 7_200;
    this.cachedToken = {
      token: body.tenant_access_token,
      expiresAt: Date.now() + Math.max(60, expireSeconds - 300) * 1_000,
    };
    return body.tenant_access_token;
  }
}

async function withRetry(run: () => Promise<Response>): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await run();
      if (!isRetryableResponseStatus(response.status) || attempt === RETRY_MAX_ATTEMPTS - 1) {
        return response;
      }
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_MAX_ATTEMPTS - 1) {
        throw error;
      }
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      continue;
    }

    await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableResponseStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
