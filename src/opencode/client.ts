type OpenCodeMessage = {
  id?: string;
  role?: string;
  parts?: Array<Record<string, unknown>>;
};

export type QuestionRequest = {
  id: string;
  sessionId: string;
  questions: Array<{ header: string; question: string }>;
};

export class OpenCodeClient {
  constructor(private readonly baseUrl: URL, private readonly directory: string) {}

  async createSession(title: string): Promise<{ id: string }> {
    return this.request("/session", {
      method: "POST",
      body: { title, directory: this.directory },
    });
  }

  async postMessage(sessionId: string, text: string): Promise<void> {
    await this.request(`/session/${sessionId}/message`, {
      method: "POST",
      body: { parts: [{ type: "text", text }] },
    });
  }

  async abort(sessionId: string): Promise<void> {
    await this.request(`/session/${sessionId}/abort`, { method: "POST" });
  }

  async replyPermission(requestId: string, policy: "once" | "always"): Promise<void> {
    await this.request(`/permission/${requestId}`, { method: "POST", body: { policy } });
  }

  async replyQuestion(requestId: string, answers: string[]): Promise<void> {
    await this.request(`/question/${requestId}`, { method: "POST", body: { answers } });
  }

  async latestAssistantReply(sessionId: string): Promise<OpenCodeMessage | null> {
    const messages = await this.request<OpenCodeMessage[]>(`/session/${sessionId}/messages`, { method: "GET" });
    return [...messages].reverse().find((message) => message.role === "assistant") ?? null;
  }

  async latestAssistantTextSince(sessionId: string, baselineId: string | null): Promise<string> {
    const messages = await this.request<OpenCodeMessage[]>(`/session/${sessionId}/messages`, { method: "GET" });
    let seenBaseline = baselineId === null;
    for (const message of messages) {
      if (baselineId && message.id === baselineId) {
        seenBaseline = true;
        continue;
      }
      if (!seenBaseline || message.role !== "assistant") {
        continue;
      }

      const text = message.parts?.map((part) => (typeof part.text === "string" ? part.text : "")).join("").trim();
      if (text) {
        return text;
      }
    }

    return "";
  }

  private async request<T>(pathName: string, options: { method: string; body?: unknown }): Promise<T> {
    const url = new URL(pathName.replace(/^\//, ""), this.baseUrl);
    const init: RequestInit = {
      method: options.method,
      headers: {
        "Content-Type": "application/json",
      },
    };
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(url, init);

    if (!response.ok) {
      throw new Error(`OpenCode request failed: ${response.status} ${response.statusText}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}
