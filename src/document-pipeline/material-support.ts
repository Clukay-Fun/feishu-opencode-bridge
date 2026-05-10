/**
 * 职责: 定义文件型业务模块共享的材料格式支持规则。
 * 关注点:
 * - 统一普通文档、图片、表格和文件夹压缩包的扩展名集合。
 * - 给知识库、劳动工作台等模块提供同一份默认白名单。
 * - 只描述格式能力，不承载任何业务领域语义。
 */

export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".txt",
  ".md",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".xls",
  ".xlsx",
  ".csv",
] as const;

export const SUPPORTED_ARCHIVE_EXTENSIONS = [".zip"] as const;

export const SUPPORTED_MATERIAL_EXTENSIONS = [
  ...SUPPORTED_DOCUMENT_EXTENSIONS,
  ...SUPPORTED_ARCHIVE_EXTENSIONS,
] as const;

export function normalizeAllowedExtensions(extensions: readonly string[]): string[] {
  return [...new Set(extensions
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`))];
}
