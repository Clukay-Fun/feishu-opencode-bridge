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
import type { ConfigLoadContext, ModuleConfigDefinition } from "./module-registry.js";
import { moduleConfigRegistry } from "./modules.js";
import { resolveProfileExtensionDefault, type BridgeProfile, type ProfileManagedExtensionId } from "./profiles.js";
import type { ContractAssistantConfig } from "../contract-assistant/config.js";
import type { ExtensionMetaDefinition } from "../extension-api/index.js";
import { builtinExtensionMetas } from "../extensions/builtin-meta.js";
import type { KnowledgeBaseConfig } from "../knowledge/config.js";
import type { LaborSkillConfig } from "../labor/config.js";

export type ConfigWarning = {
  code: "extension-config-overrides-legacy" | "profile-extension-auto-disabled";
  extensionId: string;
  configKey: string;
  message: string;
};

/** 从配置文件读取、校验并返回完整运行时配置。 */
export async function loadConfig(
  input?: string | { configPath?: string | undefined; extensionMetas?: readonly ExtensionMetaDefinition[] | undefined },
): Promise<AppConfig> {
  const result = await loadConfigWithWarnings(input);
  return result.config;
}

/** 从配置文件读取、校验并返回完整运行时配置以及兼容层 warning。 */
export async function loadConfigWithWarnings(
  input?: string | { configPath?: string | undefined; extensionMetas?: readonly ExtensionMetaDefinition[] | undefined },
): Promise<{ config: AppConfig; warnings: ConfigWarning[] }> {
  const options = typeof input === "string" ? { configPath: input } : input;
  const defaultConfigPath = process.env.BRIDGE_CONFIG_PATH && process.env.BRIDGE_CONFIG_PATH.trim().length > 0
    ? process.env.BRIDGE_CONFIG_PATH
    : "config.json";
  const resolvedConfigPath = path.resolve(options?.configPath ?? defaultConfigPath);
  const raw = JSON.parse(await readFile(resolvedConfigPath, "utf8")) as unknown;
  const rawRecord = asRecord(raw);
  const parsed = ConfigSchema.parse(stripOverriddenLegacyModuleConfigs(rawRecord));
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
  const builtinNamespace = resolveBuiltinExtensionNamespaceConfigs(rawRecord, parsed);
  const effectiveParsed = {
    ...parsed,
    ...builtinNamespace.moduleParsedConfigs,
  };
  const moduleConfigs = moduleConfigRegistry.normalize<{
    knowledgeBase: KnowledgeBaseConfig;
    contractAssistant: ContractAssistantConfig;
    laborSkill: LaborSkillConfig;
  }>(
    effectiveParsed,
    configLoadContext,
  );
  const profileResolution = resolveProfileExtensionEnabled({
    profile: parsed.profile,
    raw: rawRecord,
    parsedEnabled: {
      "memory": parsed.memory.enabled,
      "knowledge-base": moduleConfigs.knowledgeBase.enabled,
      "contract-assistant": moduleConfigs.contractAssistant.enabled,
      "labor-skill": moduleConfigs.laborSkill.enabled,
      "case-workbench": parsed.caseWorkbench.enabled,
    },
    hasEmbeddingProvider: Boolean(resolvedEmbeddingProvider),
  });
  moduleConfigs.knowledgeBase.enabled = profileResolution.enabled["knowledge-base"];
  moduleConfigs.contractAssistant.enabled = profileResolution.enabled["contract-assistant"];
  moduleConfigs.laborSkill.enabled = profileResolution.enabled["labor-skill"];
  validateEffectiveModuleConfigs(moduleConfigs, resolvedEmbeddingProvider);
  const extensionConfigs = normalizeExternalExtensionConfigs(
    rawRecord.extensions && typeof rawRecord.extensions === "object" && !Array.isArray(rawRecord.extensions)
      ? rawRecord.extensions as Record<string, unknown>
      : {},
    options?.extensionMetas ?? [],
    builtinNamespace.consumedExtensionIds,
    configLoadContext,
  );

  const config = {
    profile: parsed.profile,
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
    costs: {
      enabled: parsed.costs.enabled,
      currency: parsed.costs.currency,
      dailyLimitCny: parsed.costs.dailyLimitCny,
      modelPrices: parsed.costs.modelPrices,
    },
    updates: {
      checkOnStart: parsed.updates.checkOnStart,
      githubRepo: parsed.updates.githubRepo,
      channel: parsed.updates.channel,
    },
    persona: {
      enabled: parsed.persona.enabled,
      profile: parsed.persona.profile,
      scope: parsed.persona.scope,
    },
    memory: {
      enabled: profileResolution.enabled["memory"],
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
    caseWorkbench: {
      enabled: profileResolution.enabled["case-workbench"],
    },
    ...(Object.keys(extensionConfigs).length > 0 ? { extensions: extensionConfigs } : {}),
    knowledgeBase: moduleConfigs.knowledgeBase,
    contractAssistant: moduleConfigs.contractAssistant,
    laborSkill: moduleConfigs.laborSkill,
  };

  return {
    config,
    warnings: [...builtinNamespace.warnings, ...profileResolution.warnings],
  };
}

function normalizeExternalExtensionConfigs(
  rawExtensions: Record<string, unknown>,
  extensionMetas: readonly ExtensionMetaDefinition[],
  consumedExtensionIds: ReadonlySet<string>,
  context: ConfigLoadContext,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = Object.fromEntries(
    Object.entries(rawExtensions).filter(([key]) => !consumedExtensionIds.has(key)),
  );
  for (const meta of extensionMetas) {
    if (consumedExtensionIds.has(meta.id)) {
      continue;
    }
    const definition = meta.configDefinition;
    if (!definition) {
      continue;
    }
    const inputKey = Object.prototype.hasOwnProperty.call(rawExtensions, meta.id)
      ? meta.id
      : definition.key;
    if (!Object.prototype.hasOwnProperty.call(rawExtensions, inputKey)) {
      continue;
    }
    const parsed = parseModuleConfig(definition, rawExtensions[inputKey]);
    normalized[inputKey] = definition.normalize(parsed, context);
  }
  return normalized;
}

function resolveBuiltinExtensionNamespaceConfigs(
  raw: Record<string, unknown>,
  parsed: Record<string, unknown> & { extensions: Record<string, unknown> },
): {
  moduleParsedConfigs: Record<string, unknown>;
  consumedExtensionIds: ReadonlySet<string>;
  warnings: ConfigWarning[];
} {
  const moduleParsedConfigs: Record<string, unknown> = {};
  const consumedExtensionIds = new Set<string>();
  const warnings: ConfigWarning[] = [];
  const rawExtensions = raw.extensions && typeof raw.extensions === "object" && !Array.isArray(raw.extensions)
    ? raw.extensions as Record<string, unknown>
    : {};

  for (const meta of builtinExtensionMetas) {
    const definition = meta.configDefinition;
    const configKey = meta.configKey;
    if (!definition || !configKey) {
      continue;
    }
    const hasNamespaceConfig = Object.prototype.hasOwnProperty.call(rawExtensions, meta.id);
    if (!hasNamespaceConfig) {
      moduleParsedConfigs[configKey] = parsed[configKey];
      continue;
    }
    consumedExtensionIds.add(meta.id);
    if (Object.prototype.hasOwnProperty.call(raw, configKey)) {
      warnings.push({
        code: "extension-config-overrides-legacy",
        extensionId: meta.id,
        configKey,
        message: `extensions["${meta.id}"] 已覆盖 legacy 顶层配置 ${configKey}`,
      });
    }
    moduleParsedConfigs[configKey] = parseModuleConfig(definition, rawExtensions[meta.id]);
  }

  return { moduleParsedConfigs, consumedExtensionIds, warnings };
}

function parseModuleConfig<Parsed>(
  definition: ModuleConfigDefinition<Parsed, unknown>,
  raw: unknown,
): Parsed {
  return definition.schema.parse(raw);
}

function validateEffectiveModuleConfigs(
  moduleConfigs: { knowledgeBase: KnowledgeBaseConfig },
  resolvedEmbeddingProvider: unknown,
): void {
  if (
    moduleConfigs.knowledgeBase.enabled
    && !moduleConfigs.knowledgeBase.embeddingProvider
    && !resolvedEmbeddingProvider
  ) {
    throw new Error("knowledgeBase.enabled=true 时必须提供 knowledgeBase.embeddingProvider，或复用 embeddings.provider / memory.embeddingProvider");
  }
}

/** 受 profile 控制的内置扩展 enabled 在原始配置中的位置。 */
const PROFILE_EXTENSION_CONFIG_LOCATIONS: Record<ProfileManagedExtensionId, { legacyKey: string; namespaced: boolean }> = {
  "memory": { legacyKey: "memory", namespaced: false },
  "knowledge-base": { legacyKey: "knowledgeBase", namespaced: true },
  "contract-assistant": { legacyKey: "contractAssistant", namespaced: true },
  "labor-skill": { legacyKey: "laborSkill", namespaced: true },
  "case-workbench": { legacyKey: "caseWorkbench", namespaced: false },
};

/** 判断用户是否在原始配置里显式声明了某扩展的 enabled（legacy 顶层或 extensions 命名空间）。 */
function hasExplicitEnabled(
  raw: Record<string, unknown>,
  location: { legacyKey: string; namespaced: boolean },
  extensionId: string,
): boolean {
  const legacy = asRecord(raw[location.legacyKey]);
  if (Object.prototype.hasOwnProperty.call(legacy, "enabled")) {
    return true;
  }
  if (location.namespaced) {
    const namespace = asRecord(asRecord(raw.extensions)[extensionId]);
    if (Object.prototype.hasOwnProperty.call(namespace, "enabled")) {
      return true;
    }
  }
  return false;
}

/**
 * 解析每个内置扩展的最终 enabled。
 * - 用户显式声明的 enabled 始终优先。
 * - 否则取 profile 默认值。
 * - 知识库 profile 默认启用但缺 embeddingProvider 时优雅降级为关闭并记 warning。
 */
function resolveProfileExtensionEnabled(options: {
  profile: BridgeProfile;
  raw: Record<string, unknown>;
  parsedEnabled: Record<ProfileManagedExtensionId, boolean>;
  hasEmbeddingProvider: boolean;
}): { enabled: Record<ProfileManagedExtensionId, boolean>; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const enabled = {} as Record<ProfileManagedExtensionId, boolean>;
  for (const extensionId of Object.keys(PROFILE_EXTENSION_CONFIG_LOCATIONS) as ProfileManagedExtensionId[]) {
    const location = PROFILE_EXTENSION_CONFIG_LOCATIONS[extensionId];
    const explicit = hasExplicitEnabled(options.raw, location, extensionId);
    let value = explicit
      ? options.parsedEnabled[extensionId]
      : resolveProfileExtensionDefault(options.profile, extensionId);
    if (extensionId === "knowledge-base" && !explicit && value && !options.hasEmbeddingProvider) {
      value = false;
      warnings.push({
        code: "profile-extension-auto-disabled",
        extensionId,
        configKey: location.legacyKey,
        message: `profile=${options.profile} 默认启用知识库，但缺少 embeddingProvider，已自动跳过；配置 embeddings.provider 或 knowledgeBase.embeddingProvider 后即可启用。`,
      });
    }
    enabled[extensionId] = value;
  }
  return { enabled, warnings };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stripOverriddenLegacyModuleConfigs(raw: Record<string, unknown>): Record<string, unknown> {
  const rawExtensions = raw.extensions && typeof raw.extensions === "object" && !Array.isArray(raw.extensions)
    ? raw.extensions as Record<string, unknown>
    : {};
  const next = { ...raw };
  for (const meta of builtinExtensionMetas) {
    if (
      meta.configKey
      && Object.prototype.hasOwnProperty.call(rawExtensions, meta.id)
      && Object.prototype.hasOwnProperty.call(next, meta.configKey)
    ) {
      delete next[meta.configKey];
    }
  }
  return next;
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
