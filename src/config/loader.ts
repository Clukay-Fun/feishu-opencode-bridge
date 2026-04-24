/**
 * 职责: 读取并规范化应用配置，输出可直接使用的 AppConfig。
 * 关注点:
 * - 从配置文件加载原始 JSON 并通过 schema 校验。
 * - 处理默认值、路径归一化和运行时友好的字段转换。
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "./schema.js";
import { ConfigSchema } from "./schema.js";
import type { ConfigLoadContext } from "./module-registry.js";
import { moduleConfigRegistry } from "./modules.js";

/** 从配置文件读取、校验并返回完整运行时配置。 */
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
  const configLoadContext: ConfigLoadContext = {
    baseDir,
    dataDir,
    resolveRelative,
    ...(resolvedEmbeddingProvider ? { resolvedEmbeddingProvider } : {}),
  };
  const moduleConfigs = moduleConfigRegistry.normalize<Pick<AppConfig, "knowledgeBase">>(parsed, configLoadContext);

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
      format: parsed.logging.format,
      messagePolicy: parsed.logging.messagePolicy,
      redactFields: parsed.logging.redactFields,
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
    knowledgeBase: moduleConfigs.knowledgeBase,
    contractAssistant: {
      enabled: parsed.contractAssistant.enabled,
      storage: {
        baseToken: parsed.contractAssistant.storage.baseToken,
        contractTableId: parsed.contractAssistant.storage.contractTableId,
        invoiceTableId: parsed.contractAssistant.storage.invoiceTableId,
        caseTableId: parsed.contractAssistant.storage.caseTableId,
      },
      models: {
        default: parsed.contractAssistant.models.default,
        draft: parsed.contractAssistant.models.draft,
        extract: parsed.contractAssistant.models.extract,
        invoice: parsed.contractAssistant.models.invoice,
        caseManage: parsed.contractAssistant.models.caseManage,
      },
      ingest: {
        contractAllowedExtensions: parsed.contractAssistant.ingest.contractAllowedExtensions.map((value) => value.trim().toLowerCase()),
        invoiceAllowedExtensions: parsed.contractAssistant.ingest.invoiceAllowedExtensions.map((value) => value.trim().toLowerCase()),
        maxFileSizeMb: parsed.contractAssistant.ingest.maxFileSizeMb,
        pendingTtlMs: parsed.contractAssistant.ingest.pendingTtlMs,
      },
      reminder: {
        enabled: parsed.contractAssistant.reminder.enabled,
        targetChatIds: parsed.contractAssistant.reminder.targetChatIds,
        hour: parsed.contractAssistant.reminder.hour,
        minute: parsed.contractAssistant.reminder.minute,
        lookaheadDays: parsed.contractAssistant.reminder.lookaheadDays,
      },
    },
    laborSkill: {
      enabled: parsed.laborSkill.enabled,
      models: {
        default: parsed.laborSkill.models.default,
        extract: parsed.laborSkill.models.extract,
        analyze: parsed.laborSkill.models.analyze,
      },
      ingest: {
        allowedExtensions: parsed.laborSkill.ingest.allowedExtensions.map((value) => value.trim().toLowerCase()),
        maxFileSizeMb: parsed.laborSkill.ingest.maxFileSizeMb,
        pendingTtlMs: parsed.laborSkill.ingest.pendingTtlMs,
      },
      storage: {
        evidenceLedger: parsed.laborSkill.storage.evidenceLedger
          ? {
            appToken: parsed.laborSkill.storage.evidenceLedger.appToken,
            tableId: parsed.laborSkill.storage.evidenceLedger.tableId,
            keyEvidenceViewId: parsed.laborSkill.storage.evidenceLedger.keyEvidenceViewId,
            missingEvidenceViewId: parsed.laborSkill.storage.evidenceLedger.missingEvidenceViewId,
          }
          : undefined,
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
