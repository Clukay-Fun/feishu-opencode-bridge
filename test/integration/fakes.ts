import { vi } from "vitest";

import type { FeishuPostPayload } from "../../src/feishu/formatter.js";
import type { Logger } from "../../src/logging/logger.js";
import type {
  OpenCodeHealth,
  OpenCodeMessage,
  OpenCodeProject,
  OpenCodeProvidersResponse,
  OpenCodePromptRequest,
  OpenCodeSession,
  OpenCodeSessionStatus,
  PermissionPolicy,
} from "../../src/opencode/client.js";
import type { OpenCodeEvent } from "../../src/opencode/events.js";

type EventListener = (event: OpenCodeEvent) => void | Promise<void>;

export class FakeOpenCodeEventStream {
  private readonly listeners = new Set<EventListener>();

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getConnectionState(): "connected" {
    return "connected";
  }

  async emit(event: OpenCodeEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}

export class FakeOpenCodeClient {
  readonly sessions = new Map<string, OpenCodeSession>();
  readonly messages = new Map<string, OpenCodeMessage[]>();
  constructor(
    private readonly stream: FakeOpenCodeEventStream,
    private readonly options: { finalText: string },
  ) {}

  async health(): Promise<OpenCodeHealth> {
    return { healthy: true, version: "fake" };
  }

  async getCurrentProject(): Promise<OpenCodeProject> {
    return {
      id: "proj_1",
      worktree: process.cwd(),
      sandboxes: [],
      time: { created: 1, updated: 1 },
    };
  }

  async createSession(title: string): Promise<OpenCodeSession> {
    const session: OpenCodeSession = {
      id: `ses_${this.sessions.size + 1}`,
      title,
      time: { created: Date.now(), updated: Date.now() },
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    return session;
  }

  async listSessions(): Promise<OpenCodeSession[]> {
    return [...this.sessions.values()];
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
    return true;
  }

  async getSessionStatuses(): Promise<Record<string, OpenCodeSessionStatus>> {
    return {};
  }

  async getSessionMessages(sessionId: string): Promise<OpenCodeMessage[]> {
    return this.messages.get(sessionId) ?? [];
  }

  async promptAsync(sessionId: string, request: OpenCodePromptRequest): Promise<{ accepted: true }> {
    void request;
    const assistantMessage: OpenCodeMessage = {
      info: {
        id: `msg_${sessionId}`,
        role: "assistant",
        sessionID: sessionId,
        finish: "stop",
        time: { created: Date.now(), completed: Date.now() },
      },
      parts: [{ id: `part_${sessionId}`, type: "text", text: this.options.finalText, messageID: `msg_${sessionId}`, sessionID: sessionId }],
    };
    this.messages.set(sessionId, [assistantMessage]);

    queueMicrotask(() => {
      void this.stream.emit({
        type: "message.updated",
        properties: { info: { id: `msg_${sessionId}`, role: "assistant", sessionID: sessionId } },
        sessionId,
        receivedAt: Date.now(),
        streamEndpoint: "/event",
        raw: {},
      }).then(() => this.stream.emit({
        type: "message.part.delta",
        properties: { sessionID: sessionId, messageID: `msg_${sessionId}`, field: "text", delta: this.options.finalText },
        sessionId,
        receivedAt: Date.now(),
        streamEndpoint: "/event",
        raw: {},
      })).then(() => this.stream.emit({
        type: "session.idle",
        properties: { sessionID: sessionId },
        sessionId,
        receivedAt: Date.now(),
        streamEndpoint: "/event",
        raw: {},
      }));
    });

    return { accepted: true };
  }

  async abort(): Promise<boolean> { return true; }

  async listProviders(): Promise<OpenCodeProvidersResponse> { return { providers: [], default: {} }; }

  async runCommand(): Promise<OpenCodeMessage | null> { return null; }

  async replyPermission(sessionId: string, permissionId: string, response: PermissionPolicy, remember: boolean): Promise<boolean> {
    void sessionId;
    void permissionId;
    void response;
    void remember;
    return true;
  }

  async replyQuestion(): Promise<void> {}
}

export function createOutbound() {
  return {
    sendMessage: vi.fn(async (chatId: string, payload: FeishuPostPayload) => {
      void chatId;
      void payload;
      return { messageId: `om_send_${crypto.randomUUID()}` };
    }),
    replyMessage: vi.fn(async (messageId: string, payload: FeishuPostPayload) => {
      void messageId;
      void payload;
      return { messageId: `om_reply_${crypto.randomUUID()}` };
    }),
    updateMessage: vi.fn(async (messageId: string, payload: FeishuPostPayload) => {
      void messageId;
      void payload;
      return { messageId: `om_update_${crypto.randomUUID()}` };
    }),
  };
}

export function createWhitelist() {
  return {
    isBound() { return false; },
    async unbind() { return false; },
    count() { return 0; },
  };
}

export function createLogger(): Logger {
  return {
    log() {},
    logTranscript() {},
  };
}
