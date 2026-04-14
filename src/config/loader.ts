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
  const resolvedEmbeddingProvider = parsed.embeddings.provider ?? parsed.memory.embeddingProvider;
  const resolvedEmbeddingThreshold = parsed.embeddings.similarityThreshold
    ?? parsed.memory.embeddingSimilarityThreshold
    ?? 0.75;
  const resolvedKnowledgeEmbeddingProvider = parsed.knowledgeBase.embeddingProvider ?? resolvedEmbeddingProvider;

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
      cardActions: {
        enabled: parsed.feishu.cardActions.enabled,
        path: normalizeRoutePath(parsed.feishu.cardActions.path),
        verificationToken: parsed.feishu.cardActions.verificationToken,
        encryptKey: parsed.feishu.cardActions.encryptKey,
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
    server: {
      host: parsed.server.host,
      port: parsed.server.port,
      publicBaseUrl: new URL(parsed.server.publicBaseUrl),
    },
    whitelist: {
      storePath: resolveRelative(dataDir, parsed.whitelist.storePath),
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
    embeddings: {
      provider: resolvedEmbeddingProvider
        ? {
          baseUrl: new URL(resolvedEmbeddingProvider.baseUrl),
          apiKey: resolvedEmbeddingProvider.apiKey,
          model: resolvedEmbeddingProvider.model,
        }
        : undefined,
      similarityThreshold: resolvedEmbeddingThreshold,
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
      embeddingProvider: resolvedEmbeddingProvider
        ? {
          baseUrl: new URL(resolvedEmbeddingProvider.baseUrl),
          apiKey: resolvedEmbeddingProvider.apiKey,
          model: resolvedEmbeddingProvider.model,
        }
        : undefined,
      obsidian: {
        enabled: parsed.memory.obsidian.enabled,
        vaultPath: parsed.memory.obsidian.vaultPath
          ? resolveRelative(baseDir, parsed.memory.obsidian.vaultPath)
          : undefined,
        syncCron: parsed.memory.obsidian.syncCron,
        enableWikiLinks: parsed.memory.obsidian.enableWikiLinks,
      },
    },
    knowledgeBase: {
      enabled: parsed.knowledgeBase.enabled,
      autoDetect: {
        enabled: parsed.knowledgeBase.autoDetect.enabled,
        minConfidence: parsed.knowledgeBase.autoDetect.minConfidence,
      },
      query: {
        topK: parsed.knowledgeBase.query.topK,
        finalTopN: parsed.knowledgeBase.query.finalTopN,
        keywordFallbackLimit: parsed.knowledgeBase.query.keywordFallbackLimit,
      },
      storage: {
        sqlitePath: resolveRelative(baseDir, parsed.knowledgeBase.storage.sqlitePath ?? path.join(dataDir, "knowledge-base.db")),
        bitable: {
          appToken: parsed.knowledgeBase.storage.bitable.appToken,
          tableId: parsed.knowledgeBase.storage.bitable.tableId,
          documentTableId: parsed.knowledgeBase.storage.bitable.documentTableId,
          sourceFileField: parsed.knowledgeBase.storage.bitable.sourceFileField
            ? {
              name: parsed.knowledgeBase.storage.bitable.sourceFileField.name,
              type: parsed.knowledgeBase.storage.bitable.sourceFileField.type,
              urlTemplate: parsed.knowledgeBase.storage.bitable.sourceFileField.urlTemplate,
              textTemplate: parsed.knowledgeBase.storage.bitable.sourceFileField.textTemplate,
            }
            : undefined,
          statuteField: parsed.knowledgeBase.storage.bitable.statuteField
            ? {
              name: parsed.knowledgeBase.storage.bitable.statuteField.name,
              type: parsed.knowledgeBase.storage.bitable.statuteField.type,
              urlTemplate: parsed.knowledgeBase.storage.bitable.statuteField.urlTemplate,
              textTemplate: parsed.knowledgeBase.storage.bitable.statuteField.textTemplate,
            }
            : undefined,
        },
      },
      embeddingProvider: resolvedKnowledgeEmbeddingProvider
        ? {
          baseUrl: new URL(resolvedKnowledgeEmbeddingProvider.baseUrl),
          apiKey: resolvedKnowledgeEmbeddingProvider.apiKey,
          model: resolvedKnowledgeEmbeddingProvider.model,
        }
        : undefined,
      models: {
        default: parsed.knowledgeBase.models.default,
        webRead: parsed.knowledgeBase.models.webRead,
        extract: parsed.knowledgeBase.models.extract,
        rerank: parsed.knowledgeBase.models.rerank,
      },
      ingest: {
        allowedExtensions: parsed.knowledgeBase.ingest.allowedExtensions.map((value) => value.trim().toLowerCase()),
        maxFileSizeMb: parsed.knowledgeBase.ingest.maxFileSizeMb,
        pendingTtlMs: parsed.knowledgeBase.ingest.pendingTtlMs,
        sessionIdleMs: parsed.knowledgeBase.ingest.sessionIdleMs,
        concurrency: parsed.knowledgeBase.ingest.concurrency,
        maxExtractChunks: parsed.knowledgeBase.ingest.maxExtractChunks,
        maxExtractQas: parsed.knowledgeBase.ingest.maxExtractQas,
      },
    },
    laborSkill: {
      enabled: parsed.laborSkill.enabled,
      models: {
        extract: parsed.laborSkill.models.extract,
        analyze: parsed.laborSkill.models.analyze,
        render: parsed.laborSkill.models.render,
      },
      ingest: {
        allowedExtensions: parsed.laborSkill.ingest.allowedExtensions.map((value) => value.trim().toLowerCase()),
        maxFileSizeMb: parsed.laborSkill.ingest.maxFileSizeMb,
        pendingTtlMs: parsed.laborSkill.ingest.pendingTtlMs,
        concurrency: parsed.laborSkill.ingest.concurrency,
      },
    },
  };
}

function resolveRelative(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function normalizeRoutePath(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
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
