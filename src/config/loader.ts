import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "./schema.js";
import { ConfigSchema } from "./schema.js";

export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const resolvedConfigPath = configPath ? path.resolve(configPath) : path.resolve("config.json");
  const raw = JSON.parse(await readFile(resolvedConfigPath, "utf8")) as unknown;
  const parsed = ConfigSchema.parse(raw);
  const baseDir = path.dirname(resolvedConfigPath);
  const dataDir = resolveRelative(baseDir, parsed.storage.dataDir);
  const loggingDir = resolveRelative(baseDir, parsed.logging.dir);
  await mkdir(dataDir, { recursive: true });
  await mkdir(loggingDir, { recursive: true });

  return {
    feishu: {
      appId: parsed.feishu.appId,
      appSecret: parsed.feishu.appSecret,
      botOpenId: parsed.feishu.botOpenId,
      botOpenIds: mergeBotOpenIds(parsed.feishu.botOpenId, parsed.feishu.botOpenIds),
      botMentionNames: normalizeMentionNames(parsed.feishu.botMentionNames),
      selfBotOpenId: parsed.feishu.selfBotOpenId,
      selfBotOpenIds: mergeSelfBotOpenIds(parsed.feishu),
      wsUrl: new URL(parsed.feishu.wsUrl),
      allowedOpenIds: new Set(parsed.feishu.allowedOpenIds),
      behavior: {
        enableP2p: parsed.feishu.behavior.enableP2p,
        enableGroup: parsed.feishu.behavior.enableGroup,
        requireBotMentionInGroup: parsed.feishu.behavior.requireBotMentionInGroup,
        strictBotMention: parsed.feishu.behavior.strictBotMention,
        ignoreNonUserSenders: parsed.feishu.behavior.ignoreNonUserSenders,
        replyInThread: parsed.feishu.behavior.replyInThread,
      },
    },
    opencode: {
      baseUrl: new URL(parsed.opencode.baseUrl),
      directory: resolveRelative(baseDir, parsed.opencode.directory),
    },
    storage: {
      dataDir,
      mappingsFile: parsed.storage.mappingsFile,
    },
    bridge: {
      queueLimit: parsed.bridge.queueLimit,
      sessionModes: {
        p2p: parsed.bridge.sessions.p2pMode,
        group: parsed.bridge.sessions.groupMode,
        topicGroup: parsed.bridge.sessions.topicGroupMode,
      },
      maxSessionsPerWindow: parsed.bridge.sessions.maxSessionsPerWindow,
      sessionListLimit: parsed.bridge.sessions.listLimit,
      injectSystemState: parsed.bridge.sessions.injectSystemState,
      firstEventTimeoutMs: parsed.bridge.timeouts.firstEvent,
      eventGapTimeoutMs: parsed.bridge.timeouts.eventInterval,
      totalTimeoutMs: parsed.bridge.timeouts.totalTurn,
    },
    logging: {
      dir: loggingDir,
      level: parsed.logging.level,
      enableTranscript: parsed.logging.enableTranscript,
      enableConsole: parsed.logging.enableConsole,
      enableColor: parsed.logging.enableColor,
      rotateDaily: parsed.logging.rotateDaily,
    },
    memory: {
      enabled: parsed.memory.enabled,
      dbPath: resolveRelative(baseDir, parsed.memory.dbPath ?? path.join(dataDir, "memory.db")),
      maxMemoriesPerUser: parsed.memory.maxMemoriesPerUser,
      searchLimit: parsed.memory.searchLimit,
      extractQueueLimit: parsed.memory.extractQueueLimit,
      sourcePreviewLength: parsed.memory.sourcePreviewLength,
      shutdownDrainTimeoutMs: parsed.memory.shutdownDrainTimeoutMs,
      retriever: parsed.memory.retriever,
      embeddingProvider: parsed.memory.embeddingProvider
        ? {
          baseUrl: new URL(parsed.memory.embeddingProvider.baseUrl),
          apiKey: parsed.memory.embeddingProvider.apiKey,
          model: parsed.memory.embeddingProvider.model,
        }
        : undefined,
      embeddingSimilarityThreshold: parsed.memory.embeddingSimilarityThreshold,
      obsidian: {
        enabled: parsed.memory.obsidian.enabled,
        vaultPath: parsed.memory.obsidian.vaultPath
          ? resolveRelative(baseDir, parsed.memory.obsidian.vaultPath)
          : undefined,
        syncCron: parsed.memory.obsidian.syncCron,
        enableWikiLinks: parsed.memory.obsidian.enableWikiLinks,
      },
    },
  };
}

function resolveRelative(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function mergeBotOpenIds(botOpenId: string | undefined, botOpenIds: string[]): Set<string> {
  const ids = new Set(botOpenIds);
  if (botOpenId) {
    ids.add(botOpenId);
  }
  return ids;
}

function mergeSelfBotOpenIds(feishu: {
  botOpenId?: string | undefined;
  botOpenIds: string[];
  selfBotOpenId?: string | undefined;
  selfBotOpenIds: string[];
}): Set<string> {
  const selfIds = mergeBotOpenIds(feishu.selfBotOpenId, feishu.selfBotOpenIds);
  return selfIds.size > 0 ? selfIds : mergeBotOpenIds(feishu.botOpenId, feishu.botOpenIds);
}

function normalizeMentionNames(values: string[]): Set<string> {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0));
}
