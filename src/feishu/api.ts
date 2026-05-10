/**
 * 职责: 封装飞书开放平台 API 调用，并处理认证、重试和文件能力。
 * 关注点:
 * - 提供消息发送、回复、更新等常用 IM 接口。
 * - 提供文件上传和消息资源读取能力。
 * - 缓存并刷新 tenant access token，减少重复鉴权开销。
 */
import path from "node:path";

import PizZip from "pizzip";

import type { FeishuPostPayload } from "./shared-primitives.js";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

export class FeishuApiClient {
  private cachedToken: { token: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;
  private readonly bitableFieldCache = new Map<string, BitableFieldSchema[]>();

  constructor(private readonly appId: string, private readonly appSecret: string) {}

  /** 发送一条新消息到指定 chat。 */
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

  /** 回复一条已有消息。 */
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

  /** 原位更新一条已发送消息。 */
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

  /** 获取或刷新 tenant access token。 */
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

  /** 下载消息关联的文件、图片或文件夹资源。 */
  async downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: "file" | "image" | "folder",
  ): Promise<{ fileName: string; mimeType: string; buffer: Buffer }> {
    const token = await this.getTenantToken();
    if (type === "folder") {
      return await this.downloadFolderAsArchive(token, fileKey);
    }
    const response = await withRetry(() => fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }));
    if (!response.ok) {
      throw new Error(`Feishu downloadMessageResource failed: ${response.status} ${response.statusText}`);
    }
    return await readDownloadResponse(response, fileKey);
  }

  /** 创建一条多维表格记录，必要时做单选字段重试。 */
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

    if (isFieldNameNotFound(firstAttempt.msg)) {
      const tableFields = await this.listBitableFields(token, appToken, tableId).catch(() => []);
      const filteredFields = filterBitableFieldsBySchema(fields, tableFields);
      if (Object.keys(filteredFields).length === 0) {
        throw new Error(`Feishu createBitableRecord failed: ${firstAttempt.msg}; attempted fields: ${Object.keys(fields).join(", ") || "none"}; table fields: ${tableFields.map((field) => field.name).join(", ") || "unknown"}`);
      }
      if (!hasSameFieldKeys(fields, filteredFields)) {
        const secondAttempt = await this.createBitableRecordOnce(token, appToken, tableId, filteredFields);
        if (secondAttempt.ok) {
          return secondAttempt.recordId;
        }
        throw new Error(`Feishu createBitableRecord failed: ${secondAttempt.msg}`);
      }
    }
    throw new Error(`Feishu createBitableRecord failed: ${firstAttempt.msg}`);
  }

  /** 更新一条多维表格记录。 */
  async updateBitableRecord(appToken: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
    const token = await this.getTenantToken();
    const response = await withRetry(() => fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields }),
      },
    ));
    const body = (await response.json()) as { code: number; msg?: string };
    if (!response.ok || body.code !== 0) {
      throw new Error(`Feishu updateBitableRecord failed: ${body.msg ?? response.statusText}`);
    }
  }

  /** 列出多维表格中的全部记录。 */
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

  /** 请求新的 tenant token 并更新本地缓存。 */
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

  /** 尝试创建一条 bitable 记录，并返回原始成功/失败结果。 */
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

  /** 列出多维表格字段元数据，用于字段名错误时按真实表结构降级重试。 */
  private async listBitableFields(token: string, appToken: string, tableId: string): Promise<BitableFieldSchema[]> {
    const cacheKey = `${appToken}:${tableId}`;
    const cached = this.bitableFieldCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const results: BitableFieldSchema[] = [];
    let pageToken = "";
    let hasMore = true;

    while (hasMore) {
      const url = new URL(`https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`);
      url.searchParams.set("page_size", "100");
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
          items?: Array<{ field_name?: string; name?: string; field_id?: string; type?: unknown }>;
        };
      };
      if (!response.ok || body.code !== 0) {
        throw new Error(`Feishu listBitableFields failed: ${body.msg ?? response.statusText}`);
      }
      for (const item of body.data?.items ?? []) {
        const name = typeof item.field_name === "string" && item.field_name.trim()
          ? item.field_name.trim()
          : typeof item.name === "string" && item.name.trim()
            ? item.name.trim()
            : undefined;
        if (name) {
          results.push({ name });
        }
      }
      hasMore = Boolean(body.data?.has_more && body.data.page_token);
      pageToken = body.data?.page_token ?? "";
    }

    this.bitableFieldCache.set(cacheKey, results);
    return results;
  }

  /** 飞书 folder 消息不是附件资源，需要走云空间目录枚举并在本地打包。 */
  private async downloadFolderAsArchive(token: string, folderToken: string): Promise<{ fileName: string; mimeType: string; buffer: Buffer }> {
    if (!isDriveFolderToken(folderToken)) {
      throw new Error("飞书本地文件夹消息只提供 file_v3 临时资源 key，开放平台不能直接展开目录；请将文件夹压缩为 .zip 后上传，或发送云空间文件夹链接。");
    }
    const archive = new PizZip();
    const errors: string[] = [];
    let fileCount = 0;
    const usedPaths = new Set<string>();
    const walk = async (currentFolderToken: string, prefix: string): Promise<void> => {
      const children = await this.listDriveFolderChildren(token, currentFolderToken);
      for (const child of children) {
        const childType = normalizeDriveChildType(child);
        const childToken = getDriveChildToken(child);
        const childName = getDriveChildName(child) ?? childToken ?? "未命名文件";
        if (!childToken) {
          continue;
        }
        if (childType === "folder") {
          await walk(childToken, joinZipPath(prefix, childName));
          continue;
        }
        if (childType && childType !== "file") {
          continue;
        }
        try {
          const downloaded = await this.downloadDriveFile(token, childToken, childName);
          const entryPath = uniqueZipPath(usedPaths, joinZipPath(prefix, downloaded.fileName));
          archive.file(entryPath, downloaded.buffer);
          fileCount += 1;
        } catch (error) {
          errors.push(`${childName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };

    await walk(folderToken, "");
    if (fileCount === 0) {
      const suffix = errors.length > 0 ? `；下载失败：${errors.slice(0, 3).join("；")}` : "";
      throw new Error(`飞书文件夹内没有可下载的普通文件${suffix}`);
    }
    return {
      fileName: folderToken,
      mimeType: "application/zip",
      buffer: archive.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer,
    };
  }

  private async listDriveFolderChildren(token: string, folderToken: string): Promise<DriveFolderChild[]> {
    const response = await withRetry(() => fetch(`https://open.feishu.cn/open-apis/drive/explorer/v2/folder/${encodeURIComponent(folderToken)}/children`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }));
    const body = await readJsonResponse<{
      code?: number;
      msg?: string;
      data?: Record<string, unknown>;
    }>(response, "Feishu list folder children");
    if (!response.ok || body.code !== 0) {
      throw new Error(`Feishu list folder children failed: ${body.msg ?? response.statusText}`);
    }
    return normalizeDriveFolderChildren(body.data);
  }

  private async downloadDriveFile(token: string, fileToken: string, fallbackName: string): Promise<{ fileName: string; mimeType: string; buffer: Buffer }> {
    const response = await withRetry(() => fetch(`https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }));
    if (!response.ok) {
      throw new Error(`Feishu drive file download failed: ${response.status} ${response.statusText}`);
    }
    return await readDownloadResponse(response, fallbackName);
  }
}

type BitableFieldSchema = {
  name: string;
};

type DriveFolderChild = Record<string, unknown>;

function normalizeDriveFolderChildren(data: Record<string, unknown> | undefined): DriveFolderChild[] {
  const rawChildren = data?.children ?? data?.items ?? data?.files;
  if (Array.isArray(rawChildren)) {
    return rawChildren.filter(isRecord);
  }
  if (isRecord(rawChildren)) {
    return Object.values(rawChildren).filter(isRecord);
  }
  return [];
}

function normalizeDriveChildType(child: DriveFolderChild): string | null {
  const raw = child.type ?? child.obj_type ?? child.file_type ?? child.node_type;
  return typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : null;
}

function getDriveChildToken(child: DriveFolderChild): string | null {
  const raw = child.token ?? child.file_token ?? child.obj_token ?? child.node_token ?? child.folder_token;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function getDriveChildName(child: DriveFolderChild): string | null {
  const raw = child.name ?? child.title ?? child.file_name;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

async function readDownloadResponse(response: Response, fallbackName: string): Promise<{ fileName: string; mimeType: string; buffer: Buffer }> {
  const disposition = response.headers.get("content-disposition") ?? "";
  const rawFileName = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1] ?? fallbackName;
  const fileName = normalizeDownloadedFileName(rawFileName);
  const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    fileName,
    mimeType,
    buffer,
  };
}

async function readJsonResponse<T>(response: Response, operation: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(`${operation} returned non-JSON response: ${preview || response.statusText}`);
  }
}

function joinZipPath(prefix: string, name: string): string {
  const safeName = sanitizeZipPathPart(name);
  return prefix ? `${prefix}/${safeName}` : safeName;
}

function sanitizeZipPathPart(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/") || "未命名文件";
}

function uniqueZipPath(usedPaths: Set<string>, value: string): string {
  const extension = path.extname(value);
  const base = extension ? value.slice(0, -extension.length) : value;
  let candidate = value;
  let index = 2;
  while (usedPaths.has(candidate)) {
    candidate = `${base} (${index})${extension}`;
    index += 1;
  }
  usedPaths.add(candidate);
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDriveFolderToken(value: string): boolean {
  return /^fldcn[A-Za-z0-9]+$/.test(value);
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

function isFieldNameNotFound(errorMessage: string): boolean {
  return errorMessage.includes("FieldNameNotFound");
}

function filterBitableFieldsBySchema(fields: Record<string, unknown>, tableFields: BitableFieldSchema[]): Record<string, unknown> {
  if (tableFields.length === 0) {
    return fields;
  }
  const allowed = new Set(tableFields.map((field) => field.name));
  return Object.fromEntries(
    Object.entries(fields).filter(([key]) => allowed.has(key)),
  );
}

function hasSameFieldKeys(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
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
