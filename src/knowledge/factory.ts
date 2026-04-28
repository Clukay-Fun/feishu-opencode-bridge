/**
 * 职责: 统一创建知识库能力实例，避免 runtime/bridge 直接构造业务实现类。
 * 关注点:
 * - Bridge 通过 KnowledgeBasePort 使用知识库能力。
 * - 本地 CLI 与 Bridge 复用同一套服务构造逻辑。
 */
import type { AppConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { FeishuApiClient } from "../feishu/api.js";
import type { Logger } from "../logging/logger.js";
import { OpenCodeClient } from "../opencode/client.js";
import {
  KnowledgeBaseService,
  type KnowledgeBasePort,
  type KnowledgeDocumentDetail,
  type KnowledgeDocumentSummary,
  type KnowledgeExtractPreviewResult,
  type KnowledgeIngestResult,
  type KnowledgeParsedFileResult,
  type KnowledgeQueryResult,
  type KnowledgeStatsResult,
} from "./index.js";

type KnowledgeResourcePort = {
  downloadMessageResource(messageId: string, fileKey: string, type: "file" | "image"): Promise<{
    fileName: string;
    mimeType: string;
    buffer: Buffer;
  }>;
  createBitableRecord(appToken: string, tableId: string, fields: Record<string, unknown>): Promise<string>;
  listBitableRecords(appToken: string, tableId: string): Promise<Array<{ recordId: string; fields: Record<string, unknown> }>>;
};

export type KnowledgeCliService = KnowledgeBasePort & {
  query(question: string): Promise<KnowledgeQueryResult>;
  ingestLocalFile(filePath: string): Promise<KnowledgeIngestResult>;
  ingestWebPage(request: { url: string; instruction?: string | undefined }): Promise<KnowledgeIngestResult>;
  parseLocalFile(filePath: string): Promise<KnowledgeParsedFileResult>;
  previewLocalFileExtraction(
    filePath: string,
    options?: { maxQas?: number | undefined },
  ): Promise<KnowledgeExtractPreviewResult>;
  listDocuments(options?: { limit?: number | undefined; status?: string | undefined }): Promise<KnowledgeDocumentSummary[]>;
  getDocument(id: number): Promise<KnowledgeDocumentDetail | null>;
  getStats(): Promise<KnowledgeStatsResult>;
  close(): void;
};

export type KnowledgeCliRuntime = {
  config: AppConfig;
  service: KnowledgeCliService;
  opencode: Pick<OpenCodeClient, "health">;
  bitable: Pick<FeishuApiClient, "listBitableRecords">;
  close(): void;
};

type CreateKnowledgeServiceOptions = {
  config: AppConfig;
  resources: KnowledgeResourcePort;
  opencode: OpenCodeClient;
  logger: Logger;
};

// CLI 保持 JSON-only stdout；服务层日志暂时静默，后续可补 stderr logger 方便排障。
const SILENT_LOGGER: Logger = {
  log() {},
  logTranscript() {},
};

/** 在启用知识库功能时创建知识库服务。 */
export function createKnowledgeService(options: CreateKnowledgeServiceOptions): KnowledgeBasePort | null {
  if (!options.config.knowledgeBase.enabled) {
    return null;
  }
  return new KnowledgeBaseService(
    options.config.knowledgeBase,
    options.resources,
    options.opencode,
    options.logger,
  );
}

/** 创建本地知识库 CLI 所需的完整运行时依赖。 */
export async function createKnowledgeCliRuntime(configPath?: string): Promise<KnowledgeCliRuntime> {
  const config = await loadConfig(configPath);
  ensureKnowledgeBaseEnabled(config);
  const bitable = new FeishuApiClient(config.feishu.appId, config.feishu.appSecret);
  const opencode = new OpenCodeClient(config.opencode.baseUrl);
  /**
   * CLI 模式不支持从飞书消息附件读取文件。
   * 外部调用请使用 ingestLocalFile；ingestFile 只为满足 KnowledgeBasePort 形状保留。
   */
  const service = new KnowledgeBaseService(
    config.knowledgeBase,
    {
      async downloadMessageResource() {
        throw new Error("本地知识库命令不支持消息附件下载，请改用本地路径入库。");
      },
      createBitableRecord: bitable.createBitableRecord.bind(bitable),
      listBitableRecords: bitable.listBitableRecords.bind(bitable),
    },
    opencode,
    SILENT_LOGGER,
  );

  return {
    config,
    service,
    opencode,
    bitable,
    close() {
      service.close();
    },
  };
}

function ensureKnowledgeBaseEnabled(config: AppConfig): void {
  if (!config.knowledgeBase.enabled) {
    throw new Error("knowledgeBase.enabled=false，无法执行本地知识库命令。");
  }
}
