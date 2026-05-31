/**
 * 职责: 实现 Memory v2 自主学习分类器。
 * 关注点:
 * - 第一层：规则过滤（闲聊 / 重复 / 过短过长）。
 * - 第二层：LLM 分类到 6 种 kind。
 * - task_candidate 写入 work_tasks 表，其余写入 memories 表。
 * - LLM 失败时 fallback 到 fact，不丢候选。
 */
import type { Logger } from "../logging/logger.js";
import type { OpenCodeClient, OpenCodeMessage } from "../opencode/client.js";
import type { MemoryDb } from "./db.js";
import type { TaskDb } from "./task-db.js";

export type MemoryKind = "profile" | "project" | "preference" | "constraint" | "fact" | "task_candidate";

export type ClassifyResult = {
  kind: MemoryKind;
  confidence: number;
};

type ClassifierRuleResult = {
  passed: boolean;
  reason?: string;
};

/** 规则过滤：通过的候选才进入 LLM 分类。 */
export function ruleFilter(fact: string, existingFacts: string[]): ClassifierRuleResult {
  const trimmed = fact.trim();
  if (!trimmed) {
    return { passed: false, reason: "empty" };
  }
  if (trimmed.length < 10) {
    return { passed: false, reason: "too-short" };
  }
  if (trimmed.length > 500) {
    return { passed: false, reason: "too-long" };
  }
  // 简单去重：完全匹配已有 facts
  if (existingFacts.includes(trimmed)) {
    return { passed: false, reason: "duplicate" };
  }
  return { passed: true };
}

const CLASSIFY_SYSTEM_PROMPT = [
  "你是用户事实分类器。",
  "请将以下事实分类为以下 6 种之一：",
  "- profile：用户画像、身份、协作方式",
  "- project：项目目标、架构选择、约束、状态",
  "- preference：用户偏好、风格、习惯",
  "- constraint：限制、禁忌、规则",
  "- fact：一般事实",
  "- task_candidate：待办、承诺、下一步",
  "",
  "只输出 JSON：{\"kind\": \"<kind>\", \"confidence\": <0-1>}",
  "不要输出其他内容。",
].join("\n");

export class V2Classifier {
  constructor(
    private readonly client: OpenCodeClient,
    private readonly db: MemoryDb,
    private readonly taskDb: TaskDb,
    private readonly logger: Logger,
  ) {}

  /**
   * 对话后提取并分类事实。
   * 返回写入的记忆数量。
   */
  async extractAndClassify(
    userId: string,
    userMessage: string,
    assistantMessage: string,
    options?: { scope?: string },
  ): Promise<{ saved: number; tasks: number }> {
    // 第一层：规则过滤
    const existingFacts = this.db.listFactsForUser(userId).map((m) => m.fact);
    const candidates = extractCandidateFacts(userMessage, assistantMessage);
    const filtered = candidates.filter((c) => ruleFilter(c, existingFacts).passed);

    if (filtered.length === 0) {
      return { saved: 0, tasks: 0 };
    }

    // 第二层：LLM 分类
    let saved = 0;
    let tasks = 0;
    for (const candidate of filtered) {
      const classifyResult = await this.classifyFact(candidate);
      if (classifyResult.kind === "task_candidate") {
        this.taskDb.createTask({
          userId,
          title: candidate,
          source: "inferred",
          ...(options?.scope ? { scope: options.scope } : {}),
        });
        tasks++;
      } else {
        this.db.saveFacts(userId, [{
          fact: candidate,
          sourceMessage: userMessage,
          kind: classifyResult.kind,
          confidence: classifyResult.confidence,
          ...(options?.scope ? { scope: options.scope } : {}),
        }]);
        saved++;
      }
    }

    return { saved, tasks };
  }

  /** LLM 分类，失败时 fallback 到 fact。 */
  private async classifyFact(fact: string): Promise<ClassifyResult> {
    const session = await this.client.createSession("[bridge] memory-classify");
    try {
      const response = await this.client.postMessageSync(session.id, {
        parts: [{
          type: "text",
          text: `${CLASSIFY_SYSTEM_PROMPT}\n\n事实：${fact}`,
        }],
      });
      const text = extractAssistantText(response);
      const parsed = parseClassifyResponse(text);
      if (parsed) {
        return parsed;
      }
      this.logger.log("memory/v2-classifier", "invalid LLM response, fallback to fact", { text }, "warn");
      return { kind: "fact", confidence: 0.5 };
    } catch (error) {
      this.logger.log("memory/v2-classifier", "LLM classify failed, fallback to fact", {
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
      return { kind: "fact", confidence: 0.5 };
    } finally {
      try {
        await this.client.deleteSession(session.id);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

/** 从对话中提取候选事实（简化版：按句子切分）。 */
function extractCandidateFacts(userMessage: string, _assistantMessage: string): string[] {
  void _assistantMessage;
  const candidates: string[] = [];
  const userSentences = userMessage.split(/[。！？\n]/).map((s) => s.trim()).filter((s) => s.length >= 10 && s.length <= 500);
  candidates.push(...userSentences.slice(0, 3));
  return candidates;
}

/** 解析 LLM 分类响应。 */
function parseClassifyResponse(text: string): ClassifyResult | null {
  try {
    const match = text.match(/\{[^}]+\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const kind = parsed.kind;
    const confidence = parsed.confidence;
    if (typeof kind === "string" && isMemoryKind(kind) && typeof confidence === "number") {
      return { kind, confidence: Math.max(0, Math.min(1, confidence)) };
    }
    return null;
  } catch {
    return null;
  }
}

function isMemoryKind(value: string): value is MemoryKind {
  return ["profile", "project", "preference", "constraint", "fact", "task_candidate"].includes(value);
}

function extractAssistantText(message: OpenCodeMessage): string {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .trim();
}
