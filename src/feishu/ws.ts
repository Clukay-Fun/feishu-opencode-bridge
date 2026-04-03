import * as lark from "@larksuiteoapi/node-sdk";

import type { IncomingChatMessage } from "../runtime/app.js";

type MessageHandler = (message: IncomingChatMessage) => Promise<void>;

type LoggerLike = {
  log: (scope: string, message: string, fields?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error") => void;
};

type FeishuReceiveEvent = {
  message?: {
    chat_id?: string;
    chat_type?: string;
    message_id?: string;
    message_type?: string;
    content?: string;
  };
  sender?: {
    sender_id?: {
      open_id?: string;
    };
  };
};

export class FeishuWsClient {
  private client: lark.WSClient;
  private dispatcher: lark.EventDispatcher;

  constructor(
    appId: string,
    appSecret: string,
    private readonly handler: MessageHandler,
    private readonly logger: LoggerLike,
  ) {
    this.dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        await this.handleEvent((data ?? {}) as FeishuReceiveEvent);
      },
    });

    this.client = new lark.WSClient({
      appId,
      appSecret,
    });
  }

  async start(): Promise<void> {
    await this.client.start({ eventDispatcher: this.dispatcher });
    this.logger.log("feishu/ws", "connection opened", {});
  }

  async stop(): Promise<void> {
    this.client.stop();
  }

  private async handleEvent(payload: FeishuReceiveEvent): Promise<void> {
    if (!payload.message || payload.message.message_type !== "text" || payload.message.chat_type !== "p2p") {
      return;
    }

    const text = parseFeishuText(payload.message.content ?? "");
    const incoming: IncomingChatMessage = {
      chatId: String(payload.message.chat_id ?? ""),
      senderOpenId: String(payload.sender?.sender_id?.open_id ?? ""),
      messageId: String(payload.message.message_id ?? ""),
      text,
    };

    if (!incoming.chatId || !incoming.senderOpenId || !incoming.messageId) {
      this.logger.log("feishu/ws", "skip malformed message", {
        chatId: incoming.chatId,
        senderId: incoming.senderOpenId,
        messageId: incoming.messageId,
      }, "warn");
      return;
    }

    this.logger.log("feishu/ws", "message received", {
      chatId: incoming.chatId,
      messageId: incoming.messageId,
      senderId: incoming.senderOpenId,
      textPreview: incoming.text,
      len: incoming.text.length,
    });
    await this.handler(incoming);
  }
}

function parseFeishuText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? "";
  } catch {
    return content;
  }
}
