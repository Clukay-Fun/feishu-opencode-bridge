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

  async replyMessage(messageId: string, payload: FeishuPostPayload, options?: { replyInThread?: boolean }): Promise<{ messageId: string }> {
    const token = await this.getTenantToken();
    const response = await withRetry(() => fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(options?.replyInThread ? { ...payload, reply_in_thread: true } : payload),
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

  async downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: "file" | "image",
  ): Promise<{ fileName: string; mimeType: string; buffer: Buffer }> {
    const token = await this.getTenantToken();
    const response = await withRetry(() => fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }));
    if (!response.ok) {
      throw new Error(`Feishu downloadMessageResource failed: ${response.status} ${response.statusText}`);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const rawFileName = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1] ?? fileKey;
    const fileName = normalizeDownloadedFileName(rawFileName);
    const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      fileName,
      mimeType,
      buffer,
    };
  }

  async createBitableRecord(appToken: string, tableId: string, fields: Record<string, unknown>): Promise<string> {
    const token = await this.getTenantToken();
    const firstAttempt = await this.createBitableRecordOnce(token, appToken, tableId, fields);
    if (firstAttempt.ok) {
      return firstAttempt.recordId;
    }

    const retryFields = normalizeFieldsForSingleSelectRetry(fields, firstAttempt.msg);
    if (retryFields) {
      const secondAttempt = await this.createBitableRecordOnce(token, appToken, tableId, retryFields);
      if (secondAttempt.ok) {
        return secondAttempt.recordId;
      }
      throw new Error(`Feishu createBitableRecord failed: ${secondAttempt.msg}`);
    }
    throw new Error(`Feishu createBitableRecord failed: ${firstAttempt.msg}`);
  }

  async listBitableRecords(appToken: string, tableId: string): Promise<Array<{ recordId: string; fields: Record<string, unknown> }>> {
    const token = await this.getTenantToken();
    const results: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
    let pageToken = "";
    let hasMore = true;

    while (hasMore) {
      const url = new URL(`https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`);
      url.searchParams.set("page_size", "500");
      if (pageToken) {
        url.searchParams.set("page_token", pageToken);
      }
      const response = await withRetry(() => fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }));
      const body = (await response.json()) as {
        code: number;
        msg?: string;
        data?: {
          has_more?: boolean;
          page_token?: string;
          items?: Array<{ record_id?: string; fields?: Record<string, unknown> }>;
        };
      };
      if (!response.ok || body.code !== 0) {
        throw new Error(`Feishu listBitableRecords failed: ${body.msg ?? response.statusText}`);
      }
      for (const item of body.data?.items ?? []) {
        if (!item.record_id || !item.fields) {
          continue;
        }
        results.push({ recordId: item.record_id, fields: item.fields });
      }
      hasMore = Boolean(body.data?.has_more && body.data.page_token);
      pageToken = body.data?.page_token ?? "";
    }

    return results;
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

  private async createBitableRecordOnce(
    token: string,
    appToken: string,
    tableId: string,
    fields: Record<string, unknown>,
  ): Promise<{ ok: true; recordId: string } | { ok: false; msg: string }> {
    const response = await withRetry(() => fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    }));
    const body = (await response.json()) as {
      code: number;
      msg?: string;
      data?: { record?: { record_id?: string } };
    };
    const recordId = body.data?.record?.record_id;
    if (!response.ok || body.code !== 0 || !recordId) {
      return { ok: false, msg: body.msg ?? response.statusText };
    }
    return { ok: true, recordId };
  }
}

function normalizeDownloadedFileName(value: string): string {
  const decoded = safeDecodeURIComponent(value).replace(/^"+|"+$/g, "").trim();
  const repairedUtf8 = repairLatin1Mojibake(decoded, "utf8");
  if (repairedUtf8 !== decoded) {
    return repairedUtf8;
  }
  const repairedGb18030 = repairLatin1Mojibake(decoded, "gb18030");
  return repairedGb18030;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function repairLatin1Mojibake(value: string, encoding: "utf8" | "gb18030"): string {
  if (!/(Ã.|Â.|ä.|å.|æ.|ç.|è.|é.)/.test(value)) {
    return value;
  }
  try {
    const bytes = Buffer.from(value, "latin1");
    const decoded = encoding === "utf8"
      ? bytes.toString("utf8")
      : new TextDecoder("gb18030", { fatal: false }).decode(bytes);
    return scoreReadableText(decoded) > scoreReadableText(value) ? decoded : value;
  } catch {
    return value;
  }
}

function scoreReadableText(text: string): number {
  const cjkMatches = text.match(/[\u4E00-\u9FFF]/g)?.length ?? 0;
  const replacementMatches = text.match(/\uFFFD/g)?.length ?? 0;
  const mojibakeMatches = text.match(/(Ã.|Â.|ä.|å.|æ.|ç.|è.|é.)/g)?.length ?? 0;
  return cjkMatches * 2 - replacementMatches * 3 - mojibakeMatches;
}

function normalizeFieldsForSingleSelectRetry(fields: Record<string, unknown>, errorMessage: string): Record<string, unknown> | null {
  if (!errorMessage.includes("SingleSelectFieldConvFail")) {
    return null;
  }
  const tags = fields["标签"];
  if (!Array.isArray(tags)) {
    return null;
  }
  return {
    ...fields,
    标签: typeof tags[0] === "string" ? tags[0] : "",
  };
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
