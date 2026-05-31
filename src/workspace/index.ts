/**
 * 职责: File/Document Workspace 能力层模块出口。
 * 关注点:
 * - 导出 WorkspaceService 和相关类型。
 * - 为后续 Slice E 预留扩展位置。
 */
export { WorkspaceService } from "./service.js";
export { DocumentOperationJournal } from "./journal-db.js";
export { FeishuDocAdapter, parseFeishuDocUrl } from "./feishu-doc-adapter.js";
export type { WorkspaceParseResult, WorkspaceSource, DocumentOperationRecord } from "./types.js";
export type { FeishuDocType, FeishuUpdateCommand } from "./feishu-doc-adapter.js";
