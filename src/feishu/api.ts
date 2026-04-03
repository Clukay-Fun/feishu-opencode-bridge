import type { FeishuPostPayload } from "./formatter.js";

export class FeishuApiClient {
  constructor(private readonly appId: string, private readonly appSecret: string) {}

  async sendMessage(chatId: string, payload: FeishuPostPayload): Promise<{ messageId: string }> {
    const token = await this.fetchTenantToken();
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ receive_id: chatId, ...payload }),
    });
    const body = (await response.json()) as { code: number; msg?: string; data?: { message_id?: string } };
    if (!response.ok || body.code !== 0 || !body.data?.message_id) {
      throw new Error(`Feishu sendMessage failed: ${body.msg ?? response.statusText}`);
    }
    return { messageId: body.data.message_id };
  }

  async updateMessage(messageId: string, payload: FeishuPostPayload): Promise<{ messageId: string }> {
    const token = await this.fetchTenantToken();
    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as { code: number; msg?: string; data?: { message_id?: string } };
    if (!response.ok || body.code !== 0) {
      throw new Error(`Feishu updateMessage failed: ${body.msg ?? response.statusText}`);
    }
    return { messageId: body.data?.message_id ?? messageId };
  }

  private async fetchTenantToken(): Promise<string> {
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const body = (await response.json()) as { code: number; msg?: string; tenant_access_token?: string };
    if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`Feishu fetch token failed: ${body.msg ?? response.statusText}`);
    }
    return body.tenant_access_token;
  }
}
