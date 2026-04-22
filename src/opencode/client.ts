/**
 * 职责: 封装与 OpenCode 服务的 HTTP 交互。
 * 关注点:
 * - 提供会话创建、消息发送、异步提示和模型查询等接口。
 * - 暴露桥接层需要使用的核心类型定义。
 */
export type OpenCodeHealth = {
  healthy: true;
  version: string;
};

export type OpenCodeProject = {
  id: string;
  worktree: string;
  vcs?: string;
  sandboxes: string[];
  time: {
    created: number;
    updated: number;
    initialized?: number;
  };
};

export type OpenCodeSession = {
  id: string;
  slug?: string;
  version?: string;
  projectID?: string;
  directory?: string;
  title?: string;
  time?: {
    created?: number;
    updated?: number;
  };
};

export type OpenCodeSessionStatus = {
  type: string;
  [key: string]: unknown;
};

export type OpenCodeMessageInfo = Record<string, unknown> & {
  id?: string;
  parentID?: string;
  role?: string;
  sessionID?: string;
  finish?: string;
  time?: Record<string, unknown>;
};

export type OpenCodePart = Record<string, unknown> & {
  id?: string;
  type?: string;
  text?: string;
  messageID?: string;
  sessionID?: string;
};

export type OpenCodeMessage = {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
};

export type OpenCodePromptPart = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export type OpenCodeModelRef = {
  modelID: string;
  providerID?: string;
  [key: string]: unknown;
};

export type OpenCodePromptRequest = {
  messageID?: string;
  model?: OpenCodeModelRef | Record<string, unknown>;
  agent?: string;
  noReply?: boolean;
  system?: string;
  tools?: unknown;
  parts: OpenCodePromptPart[];
};

export type OpenCodeCommandRequest = {
  messageID?: string;
  agent?: string;
  model?: OpenCodeModelRef | Record<string, unknown>;
  command: string;
  arguments: string[];
};

export type OpenCodeProvidersResponse = {
  providers: Array<Record<string, unknown>>;
  default: Record<string, string>;
};

export type OpenCodePromptAccepted = {
  accepted: true;
};

export type PermissionPolicy = "once" | "always" | "reject";

export type QuestionRequest = {
  id: string;
  sessionId: string;
  questions: Array<{ header: string; question: string }>;
};

type RequestOptions = {
  method: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  expectedStatus?: number;
};

export class OpenCodeClient {
  constructor(private readonly baseUrl: URL) {}

  /** 检查 OpenCode 服务健康状态。 */
  async health(): Promise<OpenCodeHealth> {
    return this.request("/global/health", { method: "GET" });
  }

  /** 获取当前 OpenCode 项目信息。 */
  async getCurrentProject(): Promise<OpenCodeProject> {
    return this.request("/project/current", { method: "GET" });
  }

  /** 创建新的 OpenCode session。 */
  async createSession(title: string): Promise<OpenCodeSession> {
    return this.request("/session", {
      method: "POST",
      body: { title },
    });
  }

  /** 列出所有 OpenCode sessions。 */
  async listSessions(): Promise<OpenCodeSession[]> {
    return this.request("/session", { method: "GET" });
  }

  /** 删除指定 session。 */
  async deleteSession(sessionId: string): Promise<boolean> {
    return this.request(`/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  /** 获取各 session 的当前状态。 */
  async getSessionStatuses(): Promise<Record<string, OpenCodeSessionStatus>> {
    return this.request("/session/status", { method: "GET" });
  }

  /** 获取指定 session 的消息列表。 */
  async getSessionMessages(sessionId: string, limit?: number): Promise<OpenCodeMessage[]> {
    if (limit === undefined) {
      return this.request(`/session/${encodeURIComponent(sessionId)}/message`, {
        method: "GET",
      });
    }

    return this.request(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: "GET",
      query: { limit },
    });
  }

  /** 以同步方式发送消息，并等待 assistant 回复。 */
  async postMessageSync(sessionId: string, request: OpenCodePromptRequest): Promise<OpenCodeMessage> {
    return this.request(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      body: request,
    });
  }

  /** 异步提交 prompt，请求通过事件流继续返回结果。 */
  async promptAsync(sessionId: string, request: OpenCodePromptRequest): Promise<OpenCodePromptAccepted> {
    await this.request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: "POST",
      body: request,
      expectedStatus: 204,
    });
    return { accepted: true };
  }

  /** 中止指定 session 当前执行。 */
  async abort(sessionId: string): Promise<boolean> {
    return this.request(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
  }

  /** 获取模型提供方配置列表。 */
  async listProviders(): Promise<OpenCodeProvidersResponse> {
    return this.request("/config/providers", { method: "GET" });
  }

  /** 以命令模式调用 OpenCode。 */
  async runCommand(sessionId: string, request: OpenCodeCommandRequest): Promise<OpenCodeMessage> {
    return this.request(`/session/${encodeURIComponent(sessionId)}/command`, {
      method: "POST",
      body: request,
    });
  }

  /** 回应一条权限请求。 */
  async replyPermission(sessionId: string, permissionId: string, response: PermissionPolicy, remember: boolean): Promise<boolean> {
    return this.request(`/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
      method: "POST",
      body: { response, remember },
    });
  }

  /** 回答模型提出的问题。 */
  async replyQuestion(requestId: string, answers: string[]): Promise<void> {
    await this.request(`/question/${encodeURIComponent(requestId)}`, {
      method: "POST",
      body: { answers },
    });
  }

  /** 统一执行 HTTP 请求并处理状态码与 JSON 解析。 */
  private async request<T>(pathName: string, options: RequestOptions): Promise<T> {
    const url = new URL(pathName.replace(/^\//, ""), this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }

    const headers = createOpenCodeHeaders(
      options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    );
    const init: RequestInit = {
      method: options.method,
      headers,
    };
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, init);

    const expectedStatus = options.expectedStatus;
    if (expectedStatus !== undefined) {
      if (response.status !== expectedStatus) {
        throw new Error(`OpenCode request failed: ${response.status} ${response.statusText}`);
      }
      return undefined as T;
    }

    if (!response.ok) {
      throw new Error(`OpenCode request failed: ${response.status} ${response.statusText}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

export function createOpenCodeHeaders(initialHeaders?: Record<string, string>): Record<string, string> {
  const headers = { ...(initialHeaders ?? {}) };
  const authHeader = getOpenCodeAuthHeader();
  if (authHeader) {
    headers.Authorization = authHeader;
  }
  return headers;
}

export function getOpenCodeAuthHeader(): string | null {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) {
    return null;
  }

  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}
