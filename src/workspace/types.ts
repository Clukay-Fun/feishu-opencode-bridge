/**
 * 职责: 定义 File/Document Workspace 能力层的标准化输出接口。
 * 关注点:
 * - WorkspaceParseResult 是统一的解析结果 schema，供业务模块消费。
 * - meta / content / parse / journal 四层字段定义完整，V2 扩展不需要破坏性变更。
 */
import type { DocumentParserUsed, DocumentParseQuality, ParsedDocumentSection } from "../document-pipeline/index.js";

/** 文件来源类型 */
export type WorkspaceSource = "upload" | "local-path" | "feishu-doc" | "feishu-drive" | "zip-entry";

/** 文件/文档工作区统一解析结果 */
export type WorkspaceParseResult = {
  /** 文件元信息 */
  meta: {
    fileName: string;
    extension: string;
    mimeType?: string | undefined;
    size: number;
    source: WorkspaceSource;
    sourceUrl?: string | undefined;
  };

  /** 解析产出 */
  content: {
    rawText?: string | undefined;
    markdown?: string | undefined;
    sections?: ParsedDocumentSection[];
    sheets?: Array<{ name: string; headers: string[]; rows: unknown[][] }>;
    ocrText?: string | undefined;
    attachments?: Array<{ name: string; path?: string; url?: string }>;
  };

  /** 解析质量与 fallback */
  parse: {
    used: DocumentParserUsed;
    quality: DocumentParseQuality;
    fallbackChain: string[];
    warnings: string[];
    elapsedMs: number;
  };
};

/** Document Operation Journal 记录 */
export type DocumentOperationRecord = {
  id: number;
  operationId: string;
  operationType: string;
  inputPath?: string | undefined;
  outputPath?: string | undefined;
  sourceType: string;
  fileName: string;
  extension: string;
  status: string;
  usedParser?: string | undefined;
  quality?: string | undefined;
  fallbackChain?: string | undefined;
  warnings?: string | undefined;
  elapsedMs: number;
  detail?: string | undefined;
  createdAt: number;
};
