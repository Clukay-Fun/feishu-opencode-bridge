/**
 * 职责: 从对话内容中提取值得长期保留的用户事实。
 * 关注点:
 * - 借助 OpenCode 生成结构化记忆候选。
 * - 同时支持同步调用与异步轮询两种交互方式。
 */
import type { Logger } from "../logging/logger.js";
import type { OpenCodeClient, OpenCodeMessage, OpenCodePromptRequest } from "../opencode/client.js";

const EXTRACTION_SYSTEM_PROMPT = [
  "你是用户长期事实提取器。",
  "请从给定对话中提取值得长期记住的用户事实。",
  "每行一条，以“用户”开头。",
  "不要输出编号、解释、前后缀或空话。",
  "如果没有可记忆的事实，输出空字符串。",
].join("\n");

const EXTRACTION_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;
const MESSAGE_SLICE_LIMIT = 500;

export type MemoryExtractor = {
  extract(userMessage: string, assistantMessage: string): Promise<string[]>;
};

export class OpenCodeMemoryExtractor implements MemoryExtractor {
  constructor(
    private readonly client: OpenCodeClient,
    private readonly logger: Logger,
  ) {}

  /** 优先同步提取，失败时退回异步轮询提取。 */
  async extract(userMessage: string, assistantMessage: string): Promise<string[]> {
    const prompt = buildExtractionPrompt(userMessage, assistantMessage);
    const syncSession = await this.client.createSession("Memory Extraction");
    try {
      const syncMessage = await this.client.postMessageSync(syncSession.id, buildExtractionRequest(prompt));
      const syncFacts = parseFacts(extractAssistantText(syncMessage));
      if (syncFacts.length > 0) {
        return syncFacts;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.log("memory/extractor", "sync extraction failed", { detail }, "warn");
    } finally {
      await this.cleanupSession(syncSession.id, "sync");
    }

    this.logger.log("memory/extractor", "fallback", { mode: "async-poll" }, "warn");
    const asyncSession = await this.client.createSession("Memory Extraction Fallback");
    try {
      await this.client.promptAsync(asyncSession.id, buildExtractionRequest(prompt));
      const asyncText = await pollForAssistantText(this.client, asyncSession.id, EXTRACTION_TIMEOUT_MS);
      return parseFacts(asyncText);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.log("memory/extractor", "fallback extraction failed", { detail }, "warn");
      return [];
    } finally {
      await this.cleanupSession(asyncSession.id, "fallback");
    }
  }

  /** 删除临时 session；失败时只记录日志。 */
  private async cleanupSession(sessionId: string, mode: "sync" | "fallback"): Promise<void> {
    try {
      await this.client.deleteSession(sessionId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.log("memory/extractor", "session cleanup failed", {
        sessionId,
        mode,
        detail,
      }, "warn");
    }
  }
}

/** 组装记忆提取提示词正文。 */
function buildExtractionPrompt(userMessage: string, assistantMessage: string): string {
  return [
    "以下是一段对话，请提取值得长期记住的用户事实：",
    `用户: ${sliceForPrompt(userMessage)}`,
    `助手: ${sliceForPrompt(assistantMessage)}`,
  ].join("\n");
}

/** 构建供 OpenCode 使用的提取请求。 */
function buildExtractionRequest(prompt: string): OpenCodePromptRequest {
  return {
    system: EXTRACTION_SYSTEM_PROMPT,
    parts: [{ type: "text", text: prompt }],
  };
}

/** 轮询 session，直到拿到完整 assistant 回复或超时。 */
async function pollForAssistantText(client: OpenCodeClient, sessionId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSeenText = "";

  while (Date.now() < deadline) {
    const messages = await client.getSessionMessages(sessionId, 50);
    const latestAssistant = [...messages].reverse().find((message) => message.info.role === "assistant") ?? null;
    if (latestAssistant) {
      const text = extractAssistantText(latestAssistant);
      if (text) {
        lastSeenText = text;
      }
      if (text && isCompletedMessage(latestAssistant)) {
        return text;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return lastSeenText;
}

/** 从 assistant 消息中提取纯文本。 */
function extractAssistantText(message: OpenCodeMessage | null): string {
  if (!message) {
    return "";
  }

  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

/** 判断 assistant 消息是否已经完成。 */
function isCompletedMessage(message: OpenCodeMessage): boolean {
  const time = typeof message.info.time === "object" && message.info.time !== null
    ? message.info.time as Record<string, unknown>
    : null;
  return typeof message.info.finish === "string" || typeof time?.completed === "number";
}

/** 过滤并规范化可记忆事实列表。 */
function parseFacts(text: string): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("用户") && line.length >= 5 && line.length <= 100);
  return [...new Set(lines)];
}

/** 控制进入 prompt 的消息长度。 */
function sliceForPrompt(text: string): string {
  return text.trim().slice(0, MESSAGE_SLICE_LIMIT);
}

/** 简单的异步 sleep。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
